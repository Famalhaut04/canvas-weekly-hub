"""Python 3.8 标准库 TLS 回归；不读取个人配置，不请求学校课程。"""
import io
import ssl
import sys
import tempfile
import unittest
import urllib.error
import urllib.request
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
import canvas_weekly_report as engine


class TlsContextTests(unittest.TestCase):
    def test_normal_default_context_preserved(self):
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
        with mock.patch.object(engine.ssl, "create_default_context", return_value=context) as create:
            self.assertIs(engine.api_tls_context(), context)
        create.assert_called_once_with()
        self.assertTrue(context.check_hostname)
        self.assertEqual(context.verify_mode, ssl.CERT_REQUIRED)

    def test_windows_der_failure_uses_same_trusted_certificates_as_pem(self):
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
        certificates = [(b"all", "x509_asn", True), (b"server", "x509_asn", {ssl.Purpose.SERVER_AUTH.oid}),
                        (b"client-only", "x509_asn", {ssl.Purpose.CLIENT_AUTH.oid}), (b"pkcs7", "pkcs_7_asn", True)]
        with mock.patch.object(engine.sys, "platform", "win32"), \
                mock.patch.object(engine.ssl, "create_default_context", side_effect=[ssl.SSLError("fixture ASN1 error"), context]) as create, \
                mock.patch.object(engine.ssl, "enum_certificates", side_effect=[certificates, []], create=True) as enum, \
                mock.patch.object(engine.ssl, "DER_cert_to_PEM_cert", side_effect=lambda b: b.decode() + "-PEM\n") as convert:
            self.assertIs(engine.api_tls_context(), context)
        self.assertEqual(enum.call_args_list, [mock.call("CA"), mock.call("ROOT")])
        self.assertEqual(convert.call_args_list, [mock.call(b"all"), mock.call(b"server")])
        self.assertEqual(create.call_args_list, [mock.call(), mock.call(cadata="all-PEM\nserver-PEM\n")])
        self.assertTrue(context.check_hostname)
        self.assertEqual(context.verify_mode, ssl.CERT_REQUIRED)

    def test_non_windows_failure_does_not_attempt_windows_workaround(self):
        with mock.patch.object(engine.sys, "platform", "linux"), \
                mock.patch.object(engine.ssl, "create_default_context", side_effect=ssl.SSLError("fixture-token")):
            with self.assertRaises(engine.CanvasReadError) as error:
                engine.api_tls_context()
        self.assertEqual(error.exception.kind, "tls_setup_failed")
        self.assertNotIn("fixture-token", str(error.exception))

    def test_empty_or_unreadable_store_fails_closed(self):
        for store in [[], OSError("fixture-token")]:
            with mock.patch.object(engine.sys, "platform", "win32"), \
                    mock.patch.object(engine.ssl, "create_default_context", side_effect=ssl.SSLError("fixture-token")) as create, \
                    mock.patch.object(engine.ssl, "enum_certificates", side_effect=lambda name: store if isinstance(store, list) else (_ for _ in ()).throw(store), create=True):
                with self.assertRaises(engine.CanvasReadError) as error:
                    engine.api_tls_context()
            self.assertEqual(error.exception.kind, "tls_setup_failed")
            self.assertNotIn("fixture-token", str(error.exception))
            self.assertEqual(create.call_count, 1)

    def test_malformed_trusted_certificate_is_not_silently_skipped(self):
        with mock.patch.object(engine.sys, "platform", "win32"), \
                mock.patch.object(engine.ssl, "create_default_context", side_effect=ssl.SSLError("fixture")), \
                mock.patch.object(engine.ssl, "enum_certificates", return_value=[(b"bad", "x509_asn", True)], create=True), \
                mock.patch.object(engine.ssl, "DER_cert_to_PEM_cert", side_effect=ValueError("fixture-token")):
            with self.assertRaises(engine.CanvasReadError) as error:
                engine.api_tls_context()
        self.assertEqual(error.exception.kind, "tls_setup_failed")
        self.assertNotIn("fixture-token", str(error.exception))

    def test_pem_load_failure_is_safe_and_not_retried_unverified(self):
        with mock.patch.object(engine.sys, "platform", "win32"), \
                mock.patch.object(engine.ssl, "create_default_context", side_effect=ssl.SSLError("fixture-token")) as create, \
                mock.patch.object(engine.ssl, "enum_certificates", return_value=[(b"valid", "x509_asn", True)], create=True), \
                mock.patch.object(engine.ssl, "DER_cert_to_PEM_cert", return_value="fixture PEM"):
            with self.assertRaises(engine.CanvasReadError) as error:
                engine.api_tls_context()
        self.assertEqual(error.exception.kind, "tls_setup_failed")
        self.assertEqual(create.call_count, 2)
        self.assertNotIn("fixture-token", str(error.exception))

    def test_api_opener_keeps_redirect_guard_and_verified_context(self):
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
        request = urllib.request.Request("https://canvas.example/api/v1/courses")
        with mock.patch.object(engine, "api_tls_context", return_value=context), \
                mock.patch.object(engine.urllib.request, "build_opener") as build:
            engine.api_open(request, 60)
        handlers = build.call_args.args
        self.assertIsInstance(handlers[0], engine.NoApiRedirect)
        self.assertIsInstance(handlers[1], urllib.request.HTTPSHandler)
        self.assertIs(handlers[1]._context, context)
        build.return_value.open.assert_called_once_with(request, timeout=60)

    def test_verify_and_handshake_errors_distinct_from_token_failure(self):
        cases = [(ssl.SSLCertVerificationError("fixture-token"), "tls_verify_failed"),
                 (ssl.SSLError("fixture-token"), "tls_handshake_failed"),
                 (OSError("fixture-token"), "request_failed")]
        for cause, kind in cases:
            with mock.patch.object(engine, "api_open", side_effect=urllib.error.URLError(cause)):
                with self.assertRaises(engine.CanvasReadError) as error:
                    engine.api_get_all("https://canvas.example", "fixture-token", "/courses")
            self.assertEqual(error.exception.kind, kind)
            self.assertNotIn("fixture-token", str(error.exception))

    def test_context_failure_classification_preserved_by_reader(self):
        with mock.patch.object(engine, "api_open", side_effect=engine.CanvasReadError("tls_setup_failed")):
            with self.assertRaises(engine.CanvasReadError) as error:
                engine.api_get_all("https://canvas.example", "fixture-token", "/courses")
        self.assertEqual(error.exception.kind, "tls_setup_failed")

    def test_download_reuses_verified_context_without_canvas_credentials(self):
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
        with tempfile.TemporaryDirectory(suffix=".tmp", dir=str(ROOT / "tests")) as directory:
            with mock.patch.object(engine, "api_get_all", return_value=[{"url": "https://storage.example/fixture.pdf"}]), \
                    mock.patch.object(engine, "api_tls_context", return_value=context), \
                    mock.patch.object(engine.urllib.request, "urlopen", return_value=io.BytesIO(b"fixture pdf")) as opened:
                status, saved = engine.download_new_file("https://canvas.example", "fixture-token", 1,
                                                        {"id": 1, "name": "fixture.pdf"}, Path(directory))
            self.assertEqual(status, "downloaded")
            self.assertEqual(Path(saved).read_bytes(), b"fixture pdf")
            self.assertIs(opened.call_args.kwargs["context"], context)
            self.assertFalse(opened.call_args.args[0].has_header("Authorization"))
            self.assertFalse(opened.call_args.args[0].has_header("X-Canvas-Token"))


if __name__ == "__main__":
    unittest.main(verbosity=2)
