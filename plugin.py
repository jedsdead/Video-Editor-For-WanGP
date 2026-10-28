"""Video Editor plugin: a WanGP tab hosting a full non-linear editor served as a plugin web app."""

import gradio as gr

from shared.utils.plugins import WAN2GPPlugin

WEB_PATH = "/video_editor"


class VideoEditorPlugin(WAN2GPPlugin):
    def __init__(self):
        super().__init__()
        self.name = "Video Editor"
        self.version = "1.0.1"
        self.description = ("Multi-track video editor: magnetic or free timeline, blade and range tools, transitions, "
                            "colour wheels, scopes, audio mixer, speed ramps with optical flow and export.")

    def setup_ui(self):
        self.request_global("server_config")
        for name in ("get_model_def", "get_model_name", "collect_current_model_settings_with_media"):
            self.request_global(name)
        self.add_tab(tab_id="video_editor", label="Video Editor", component_constructor=self.create_ui)
        self.register_web_app(WEB_PATH, self.create_web_app)

    def _host(self):
        if getattr(self, "_wangp_host", None) is None:
            from .host import WanGPHost
            self._wangp_host = WanGPHost(self)
        return self._wangp_host

    def _data_root(self):
        import os
        config = self._config() or {}
        return os.path.join(os.path.abspath(config.get("save_path") or "outputs"), "video_editor")

    def _install_h3(self):
        """The H3 latent add-on: saves latents with every H3 video and applies the editor's pins."""
        if getattr(self, "_h3_installed", False):
            return
        self._h3_installed = True
        try:
            from . import h3pins
            h3pins.install(self, self._data_root())
        except Exception as error:
            print(f"[Video Editor] H3 latent add-on not installed: {error!r}")

    def post_ui_setup(self, components):
        self._install_h3()
        return {}

    def on_tab_select(self, state):
        try:
            self._host().capture(state)
        except Exception as error:
            print(f"[Video Editor] {error}")

    def _config(self):
        return getattr(self, "server_config", None) or {}

    def create_ui(self):
        gr.HTML(
            f'<iframe src="{WEB_PATH}/" title="Video Editor" '
            'style="width:100%;height:calc(100vh - 150px);min-height:640px;border:0;border-radius:8px;background:#16171b" '
            'allow="fullscreen; autoplay; clipboard-write"></iframe>'
        )

    def create_web_app(self):
        from .server import create_app
        self._install_h3()
        return create_app(self._config, host=self._host())
