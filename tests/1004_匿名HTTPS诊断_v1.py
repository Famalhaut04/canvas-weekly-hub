"""只测试 HTTPS 与匿名认证边界；不读取配置、Token、响应正文或个人课程。"""
import ssl
import sys
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
import canvas_weekly_report as engine


def main():
    try:
        ssl.create_default_context()
        print("Default TLS context: OK")
    except ssl.SSLError as error:
        print("Default TLS context: SSL error (%s / %s)" % (error.library or "unknown", error.reason or "unknown"))
    context = engine.api_tls_context()
    print("Project TLS context: OK")
    print("Hostname check: %s" % context.check_hostname)
    print("CERT_REQUIRED: %s" % (context.verify_mode == ssl.CERT_REQUIRED))
    if not context.check_hostname or context.verify_mode != ssl.CERT_REQUIRED:
        raise RuntimeError("TLS verification must remain enabled")
    print("No credentials supplied; personal Token remains untested")
    request = urllib.request.Request("https://canvas.cityu.edu.hk/api/v1/users/self", headers={"Accept": "application/json"})
    try:
        with engine.api_open(request, timeout=20) as response:
            status = response.status
    except urllib.error.HTTPError as error:
        status = error.code
    print("Anonymous HTTP status: %s" % status)
    return 0 if status == 401 else 1


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as error:
        print("Diagnostic failed: %s" % type(error).__name__)
        sys.exit(1)
