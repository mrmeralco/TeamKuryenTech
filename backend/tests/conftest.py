import pytest

from app.security.store import MemoryStore


@pytest.fixture(autouse=True)
def fresh_security_store():
    """Every test starts with an empty strike/ban store, so one test's strikes never ban the next test's client."""
    from app.main import app
    from app.security.middleware import SecurityMiddleware

    layer = app.middleware_stack
    while layer is not None:
        if isinstance(layer, SecurityMiddleware):
            layer.store = MemoryStore()
            break
        layer = getattr(layer, "app", None)
    yield
