"""Websocket API for the custom Starlink Lovelace card."""

from __future__ import annotations

import asyncio
from typing import Any

from starlink_grpc import GrpcError
import voluptuous as vol

from homeassistant.components import websocket_api
from homeassistant.core import HomeAssistant, callback

from .const import DOMAIN
from .coordinator import StarlinkConfigEntry, StarlinkUpdateCoordinator
from .starlink_extra import get_obstruction_map_data


def async_register_websocket_api(hass: HomeAssistant) -> None:
    """Register websocket commands for Starlink frontend data."""
    websocket_api.async_register_command(hass, websocket_obstruction_map)


def _get_coordinator(
    hass: HomeAssistant, entry_id: str | None
) -> StarlinkUpdateCoordinator:
    """Return a loaded Starlink coordinator."""
    if entry_id:
        entry = hass.config_entries.async_get_entry(entry_id)
        if entry is None or entry.domain != DOMAIN:
            raise ValueError("Starlink config entry not found")
        return entry.runtime_data

    entries: list[StarlinkConfigEntry] = [
        entry
        for entry in hass.config_entries.async_entries(DOMAIN)
        if getattr(entry, "runtime_data", None) is not None
    ]
    if not entries:
        raise ValueError("No loaded Starlink config entry found")
    return entries[0].runtime_data


@callback
def _status_payload(coordinator: StarlinkUpdateCoordinator) -> dict[str, Any]:
    """Return the status fields used by the native Lovelace card."""
    data = coordinator.data
    return {
        "downlinkThroughputBps": data.status.get("downlink_throughput_bps"),
        "uplinkThroughputBps": data.status.get("uplink_throughput_bps"),
        "popPingLatencyMs": data.status.get("pop_ping_latency_ms"),
        "popPingDropRate": data.status.get("pop_ping_drop_rate"),
        "alerts": data.alert,
        "currentlyObstructed": data.status.get("currently_obstructed"),
        "state": data.status.get("state"),
    }


@websocket_api.websocket_command(
    {
        vol.Required("type"): "starlink/obstruction_map",
        vol.Optional("entry_id"): str,
    }
)
@websocket_api.async_response
async def websocket_obstruction_map(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict[str, Any],
) -> None:
    """Return obstruction map, alignment, and light status data for the card."""
    coordinator = _get_coordinator(hass, msg.get("entry_id"))

    try:
        async with asyncio.timeout(8):
            obstruction_map = await hass.async_add_executor_job(
                get_obstruction_map_data, coordinator.channel_context
            )
    except (GrpcError, TimeoutError) as exc:
        connection.send_error(msg["id"], "fetch_failed", str(exc))
        return

    connection.send_result(
        msg["id"],
        {
            "obstructionMap": obstruction_map,
            "alignment": coordinator.data.alignment,
            "status": _status_payload(coordinator),
        },
    )
