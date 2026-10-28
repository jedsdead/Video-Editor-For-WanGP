"""Video Editor plugin: a WanGP tab hosting a full non-linear editor served as a plugin web app."""

import gradio as gr

from shared.utils.plugins import WAN2GPPlugin

WEB_PATH = "/video_editor"


class VideoEditorPlugin(WAN2GPPlugin):
    def __init__(self):
        super().__init__()
        self.name = "Video Editor"
        self.version = "0.6"
        self.description = ("Multi-track video editor: magnetic or free timeline, blade and range tools, transitions, "
                            "colour wheels, scopes, audio mixer, speed ramps with optical flow and export.")

    def setup_ui(self):
        self.request_global("server_config")
        self.add_tab(tab_id="video_editor", label="Video Editor", component_constructor=self.create_ui)
        self.register_web_app(WEB_PATH, self.create_web_app)

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
        return create_app(self._config)
