"""Bridge between the editor's server and the running WanGP: the Media Generator's current settings and WanGP's main
generation queue. Regeneration tasks join that queue like "Add New Prompt To Queue", so they show in WanGP's queue and
progress bar and run after whatever is already waiting."""

import copy
import sys
import time


class WanGPHost:
    def __init__(self, plugin):
        self.plugin = plugin
        self._service = None
        self._current = None

    # Called from the plugin's on_tab_select with the browser's state: WanGP has just saved the Media Generator form
    # into it, so this is the moment to remember the current model and settings.
    def capture(self, state):
        try:
            from shared.deepy.hybrid import service_for
            service = service_for(state)
            if service is not None:
                self._service = service
        except Exception:
            pass
        collect = getattr(self.plugin, "collect_current_model_settings_with_media", None)
        if callable(collect):
            try:
                settings = collect(state)
                try:
                    settings = copy.deepcopy(settings)
                except Exception:
                    settings = dict(settings)
                settings.pop("state", None)
                settings["_captured_at"] = time.time()
                self._current = settings
            except Exception as error:
                print(f"[Video Editor] Could not read the Media Generator settings: {error}")

    def _find_service(self):
        if self._service is not None:
            return self._service
        for module in list(sys.modules.values()):
            service = getattr(module, "_deepy_hybrid", None) if module is not None else None
            if service is not None and hasattr(service, "load_inline_queue"):
                self._service = service
                return service
        return None

    def available(self):
        if self._find_service() is None:
            return False, "WanGP's generation queue isn't reachable yet: open the Video Generator tab once, then come back"
        return True, ""

    def current_settings(self):
        return self._current

    def model_def(self, model_type):
        fn = getattr(self.plugin, "get_model_def", None)
        try:
            return fn(model_type) if callable(fn) and model_type else None
        except Exception:
            return None

    def model_name(self, model_type):
        fn = getattr(self.plugin, "get_model_name", None)
        try:
            return fn(model_type) if callable(fn) and model_type else (model_type or "")
        except Exception:
            return model_type or ""

    def submit(self, settings, callbacks, plugin_data=None):
        service = self._find_service()
        if service is None:
            raise RuntimeError("WanGP's generation queue isn't reachable")
        try:
            from . import h3pins
            h3pins.ensure_installed()   # make sure our job hooks are still the outermost ones
        except Exception:
            pass
        from shared.api import WanGPSession
        session = WanGPSession(webui_state=service._state, console_output=False, console_isatty=False, webui_append=True)
        session._gradio_webui_context = {"load_queue": service.load_inline_queue}
        task = {"params": settings, "plugin_data": dict(plugin_data or {})}
        return session.submit_task(task, callbacks=callbacks)

    def h3_status(self):
        try:
            from . import h3pins
            return h3pins.status()
        except Exception as error:
            return {"installed": False, "problems": [repr(error)]}
