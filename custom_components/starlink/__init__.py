"""The Starlink integration."""

from homeassistant.const import Platform
from typing import Any

from homeassistant.core import HomeAssistant

from .api import async_register_websocket_api
from .coordinator import StarlinkConfigEntry, StarlinkUpdateCoordinator
from .frontend import async_register_frontend

PLATFORMS = [
    Platform.BINARY_SENSOR,
    Platform.BUTTON,
    Platform.DEVICE_TRACKER,
    Platform.SENSOR,
    Platform.SWITCH,
    Platform.TIME,
]


async def async_setup(hass: HomeAssistant, config: dict[str, Any]) -> bool:
    """Set up custom Starlink integration-wide resources."""
    if not hass.data.get("starlink_custom_frontend_registered"):
        async_register_websocket_api(hass)
        await async_register_frontend(hass)
        hass.data["starlink_custom_frontend_registered"] = True

    return True


async def async_setup_entry(
    hass: HomeAssistant, config_entry: StarlinkConfigEntry
) -> bool:
    """Set up Starlink from a config entry."""
    config_entry.runtime_data = StarlinkUpdateCoordinator(hass, config_entry)
    await config_entry.runtime_data.async_config_entry_first_refresh()

    await hass.config_entries.async_forward_entry_setups(config_entry, PLATFORMS)
    return True


async def async_unload_entry(
    hass: HomeAssistant, config_entry: StarlinkConfigEntry
) -> bool:
    """Unload a config entry."""
    return await hass.config_entries.async_unload_platforms(config_entry, PLATFORMS)
