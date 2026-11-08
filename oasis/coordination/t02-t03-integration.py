import importlib.util
import io
import json
import sys
from pathlib import Path
from tempfile import TemporaryDirectory
from anorak import secrets
root = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(root / "repos/connectors/scripts"))
import check_registration as probe
import registration_audit
class FakeBackend:
    def __init__(self): self.values = {}
    def get_password(self, service, username): return self.values.get((service, username))
    def set_password(self, service, username, value): self.values[service, username] = value
    def delete_password(self, service, username): del self.values[service, username]
class FakeTransport:
    def post_form(self, url, fields):
        assert fields["refresh_token"] == "sk-FAKE-0000"
        return probe.ProbeResponse(400, b'{"error":"invalid_grant"}')
with TemporaryDirectory() as directory:
    base = Path(directory)
    store = secrets.SecretStore(FakeBackend(), lock_path=base / "secrets.lock")
    fakes = {
        probe.MICROSOFT_CLIENT_ID_KEY: "11111111-2222-3333-4444-555555555555",
        probe.MICROSOFT_TENANT_ID_KEY: "66666666-7777-8888-9999-aaaaaaaaaaaa",
        probe.GOOGLE_CLIENT_ID_KEY: "123456789012-fake.apps.googleusercontent.com",
    }
    for key, value in fakes.items(): store.set(key, value)
    secrets._DEFAULT_STORE["store"] = store
    registration_audit._default_path = lambda: base / "registration-events.jsonl"
    output = io.StringIO()
    assert probe.main([], transport=FakeTransport(), stream=output) == 0
    assert "UNVERIFIED (T11)" in output.getvalue()
    for log in base.glob("*.jsonl"):
        for value in fakes.values(): assert value not in log.read_text()
    for value in fakes.values(): assert value not in output.getvalue()
    assert len((base / "registration-events.jsonl").read_text().splitlines()) == 4
    for key in fakes: store.delete(key)
    assert store.list() == []
print("PASS: actual agent-core 0.2.0 facade + readiness probe + both audit logs; fake storage and HTTP only")
