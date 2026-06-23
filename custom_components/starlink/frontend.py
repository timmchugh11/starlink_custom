"""Frontend asset registration for the custom Starlink integration."""

from __future__ import annotations

from pathlib import Path

from homeassistant.core import HomeAssistant

try:
    from homeassistant.components.http import StaticPathConfig
except ImportError:
    StaticPathConfig = None


STATIC_URL = "/starlink-static"


async def async_register_frontend(hass: HomeAssistant) -> None:
    """Expose bundled Lovelace card assets."""
    static_path = Path(__file__).parent / "www"

    if hasattr(hass.http, "async_register_static_paths") and StaticPathConfig:
        await hass.http.async_register_static_paths(
            [StaticPathConfig(STATIC_URL, str(static_path), True)]
        )
        return

    hass.http.register_static_path(STATIC_URL, str(static_path), True)
