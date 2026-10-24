import argparse
import importlib.util
import json
import socket
import sys
from pathlib import Path


def request(port, command, parameters, timeout):
    with socket.create_connection(("127.0.0.1", port), timeout=timeout) as connection:
        connection.settimeout(timeout)
        connection.sendall(json.dumps({"type": command, "params": parameters}).encode("utf-8"))
        response = bytearray()
        while True:
            chunk = connection.recv(1048576)
            if not chunk:
                raise ConnectionError("Blender MCP disconnected before returning a complete response")
            response.extend(chunk)
            try:
                result = json.loads(response)
            except (UnicodeDecodeError, json.JSONDecodeError):
                continue
            if result.get("status") != "success":
                raise RuntimeError(json.dumps(result, ensure_ascii=False))
            return result["result"]


def serve(arguments):
    import bpy

    if bpy.app.background:
        raise RuntimeError("The installed Blender MCP bridge requires an isolated GUI process, not --background")
    addon = arguments.addon.resolve(strict=True)
    specification = importlib.util.spec_from_file_location("microglow_local_blender_mcp", addon)
    module = importlib.util.module_from_spec(specification)
    sys.modules[specification.name] = module
    specification.loader.exec_module(module)
    module.register()
    module._blendermcp_unregister_auto_start()
    for timer_name in ("_addon_update_check_on_startup", "_redraw_when_update_checked"):
        timer = getattr(module, timer_name, None)
        if timer and bpy.app.timers.is_registered(timer):
            bpy.app.timers.unregister(timer)
    bpy.context.scene.blendermcp_auto_start_server = False
    bpy.context.scene.blendermcp_port = arguments.port
    for property_name in dir(bpy.context.scene):
        if property_name.startswith("blendermcp_use_"):
            setattr(bpy.context.scene, property_name, False)
    server = module.BlenderMCPServer(host="127.0.0.1", port=arguments.port)
    server.start()
    if not server.running:
        raise RuntimeError("Could not start the local Blender MCP bridge")
    bpy.types.microglow_review_mcp = server
    print(json.dumps({"transport": "installed Blender MCP addon bridge", "host": server.host,
                      "port": server.port, "source": bpy.data.filepath}), flush=True)


def main():
    parser = argparse.ArgumentParser(description="Isolated, loopback-only client for the installed Blender MCP addon")
    parser.add_argument("mode", choices=["serve", "call"])
    parser.add_argument("--port", type=int, default=9891)
    parser.add_argument("--addon", type=Path)
    parser.add_argument("--script", type=Path)
    parser.add_argument("--arguments", default="[]")
    parser.add_argument("--code")
    parser.add_argument("--timeout", type=int, default=900)
    arguments = parser.parse_args(sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else None)
    if not 1024 <= arguments.port <= 65535:
        parser.error("Choose an unprivileged TCP port")
    if arguments.mode == "serve":
        if not arguments.addon:
            parser.error("serve requires --addon pointing to the existing blender_mcp.py")
        serve(arguments)
        return
    code = arguments.code
    if arguments.script:
        script = str(arguments.script.resolve(strict=True))
        script_arguments = json.loads(arguments.arguments)
        if not isinstance(script_arguments, list) or any(not isinstance(value, str) for value in script_arguments):
            parser.error("--arguments must be a JSON array of strings")
        code = (f"import runpy, sys\nsys.argv = [{script!r}] + {script_arguments!r}\n"
                f"runpy.run_path({script!r}, run_name='__main__')")
    if not code:
        parser.error("call requires --script or --code")
    result = request(arguments.port, "execute_code", {"code": code}, arguments.timeout)
    print(result.get("result", json.dumps(result, ensure_ascii=False)))


if __name__ == "__main__":
    main()
