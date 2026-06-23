"""Extra Starlink data helpers used by the custom Starlink integration."""

from __future__ import annotations

from typing import Any

from google.protobuf.json_format import MessageToDict
from starlink_grpc import ChannelContext, GrpcError, get_obstruction_map, get_status
import starlink_grpc


def _message_to_dict(message: Any) -> dict[str, Any]:
    """Convert a protobuf message to a JSON-friendly dict."""
    return MessageToDict(
        message,
        preserving_proto_field_name=False,
        use_integers_for_enums=False,
    )


def _raw_dish_request(
    context: ChannelContext, request: dict[str, Any], response_attr: str
) -> Any:
    """Call a raw dish gRPC request not wrapped by starlink-grpc-core."""

    def grpc_call(channel: Any) -> Any:
        if starlink_grpc.imports_pending:
            starlink_grpc.resolve_imports(channel)
        stub = starlink_grpc.DeviceStub(channel)
        response = stub.Handle(
            starlink_grpc.Request(**request),
            timeout=starlink_grpc.REQUEST_TIMEOUT,
        )
        return getattr(response, response_attr)

    return starlink_grpc.call_with_channel(grpc_call, context=context)


def get_alignment_data(context: ChannelContext) -> dict[str, Any]:
    """Fetch dish alignment stats, including desired boresight when available."""
    try:
        diagnostics = _raw_dish_request(
            context, {"get_diagnostics": {}}, "dish_get_diagnostics"
        )
        stats = getattr(diagnostics, "alignment_stats", None)
        if stats is not None:
            return _message_to_dict(stats)
    except Exception:
        # Fall back to status below. Some firmware/library combinations do not
        # expose the newer diagnostics RPC through reflection.
        pass

    try:
        status = get_status(context)
        return {
            "boresightAzimuthDeg": getattr(status, "boresight_azimuth_deg", None),
            "boresightElevationDeg": getattr(status, "boresight_elevation_deg", None),
        }
    except Exception as exc:
        raise GrpcError(exc) from exc


def get_obstruction_map_data(context: ChannelContext) -> dict[str, Any]:
    """Fetch the raw obstruction map in the shape expected by the Lovelace card."""
    try:
        data = get_obstruction_map(context)
        return {
            "numRows": getattr(data, "num_rows", 0),
            "numCols": getattr(data, "num_cols", 0),
            "snr": list(getattr(data, "snr", [])),
        }
    except Exception as exc:
        raise GrpcError(exc) from exc
