import Cogl from "gi://Cogl";
import GdkPixbuf from "gi://GdkPixbuf";
import St from "gi://St";
import Gio from "gi://Gio";
import Shell from "gi://Shell";
import Clutter from "gi://Clutter";

const WALLPAPER_BLUR_RADIUS = 30;
const WALLPAPER_BRIGHTNESS = 0.72;
const WALLPAPER_DARKNESS = 0.38;
const FALLBACK_BG_COLOR = "#2d2d2d";

export const WallpaperMixin = {
  _getWallpaperUri() {
    try {
      if (!this._wallpaperSettings) {
        this._wallpaperSettings = new Gio.Settings({
          schema_id: "org.gnome.desktop.background",
        });
      }

      let useDark = false;

      if (!this._wallpaperInterfaceSettings) {
        try {
          this._wallpaperInterfaceSettings = new Gio.Settings({
            schema_id: "org.gnome.desktop.interface",
          });
        } catch (e) {
          this._wallpaperInterfaceSettings = null;
        }
      }

      if (this._wallpaperInterfaceSettings) {
        try {
          useDark =
            this._wallpaperInterfaceSettings.get_string("color-scheme") ===
            "prefer-dark";
        } catch (e) {
          // color-scheme is unavailable.
        }
      }

      if (useDark) {
        try {
          const darkUri =
            this._wallpaperSettings.get_string("picture-uri-dark");

          if (darkUri) {
            return darkUri;
          }
        } catch (e) {
          // Fall back to the normal URI.
        }
      }

      return this._wallpaperSettings.get_string("picture-uri");
    } catch (e) {
      console.error(
        `FullscreenFadeGrid: unable to read wallpaper settings: ${e}`,
      );

      return null;
    }
  },

  _getWallpaperFile() {
    const uri = this._getWallpaperUri();

    if (!uri) {
      return null;
    }

    try {
      const file = Gio.File.new_for_uri(uri);

      if (!file.query_exists(null)) {
        return null;
      }

      return file;
    } catch (e) {
      console.error(
        `FullscreenFadeGrid: unable to open wallpaper URI ${uri}: ${e}`,
      );

      return null;
    }
  },

  _createWallpaperBackground(area) {
    if (!this._backgroundContainer) {
      return;
    }

    this._destroyWallpaperBackground();

    this._backgroundContainer.set_position(0, 0);
    this._backgroundContainer.set_size(area.width, area.height);

    /*
     * Always create a solid dark-grey background first.
     * If the wallpaper fails to load (e.g. SVG format
     * unsupported by GdkPixbuf, missing file, etc.)
     * the dark background ensures text remains readable.
     */
    this._wallpaperFallback = new St.Widget({
      style: `background-color: ${FALLBACK_BG_COLOR};`,
      reactive: false,
      x_expand: true,
      y_expand: true,
    });
    this._wallpaperFallback.set_position(0, 0);
    this._wallpaperFallback.set_size(area.width, area.height);
    this._backgroundContainer.add_child(this._wallpaperFallback);

    const file = this._getWallpaperFile();

    if (!file) return;

    const path = file.get_path();

    if (!path) {
      console.error("FullscreenFadeGrid: wallpaper is not a local file");
      return;
    }

    let pixbuf;

    try {
      pixbuf = GdkPixbuf.Pixbuf.new_from_file(path);
    } catch (e) {
      console.error(`FullscreenFadeGrid: unable to load wallpaper: ${e}`);
      return;
    }

    if (!pixbuf) return;

    const imageWidth = pixbuf.get_width();
    const imageHeight = pixbuf.get_height();

    if (imageWidth <= 0 || imageHeight <= 0) {
      return;
    }

    let options = "zoom";

    try {
      options = this._wallpaperSettings.get_string("picture-options");
    } catch (e) {
      // Keep zoom.
    }

    let renderedPixbuf = pixbuf;

    try {
      if (options === "stretched") {
        renderedPixbuf = pixbuf.scale_simple(
          Math.max(1, Math.round(area.width)),
          Math.max(1, Math.round(area.height)),
          GdkPixbuf.InterpType.BILINEAR,
        );
      } else if (options === "scaled") {
        const scale = Math.min(
          area.width / imageWidth,
          area.height / imageHeight,
        );

        const scaledWidth = Math.max(1, Math.round(imageWidth * scale));

        const scaledHeight = Math.max(1, Math.round(imageHeight * scale));

        renderedPixbuf = pixbuf.scale_simple(
          scaledWidth,
          scaledHeight,
          GdkPixbuf.InterpType.BILINEAR,
        );
      } else if (options === "centered" || options === "wallpaper") {
        renderedPixbuf = pixbuf;
      } else {
        /*
         * GNOME's zoom-style wallpaper is represented here as
         * a cover image cropped to the available area.
         */
        const scale = Math.max(
          area.width / imageWidth,
          area.height / imageHeight,
        );

        const scaledWidth = Math.max(1, Math.round(imageWidth * scale));

        const scaledHeight = Math.max(1, Math.round(imageHeight * scale));

        const scaled = pixbuf.scale_simple(
          scaledWidth,
          scaledHeight,
          GdkPixbuf.InterpType.BILINEAR,
        );

        if (scaled) {
          const cropX = Math.max(0, Math.floor((scaledWidth - area.width) / 2));

          const cropY = Math.max(
            0,
            Math.floor((scaledHeight - area.height) / 2),
          );

          const cropWidth = Math.min(
            Math.round(area.width),
            scaledWidth - cropX,
          );

          const cropHeight = Math.min(
            Math.round(area.height),
            scaledHeight - cropY,
          );

          if (cropWidth > 0 && cropHeight > 0) {
            renderedPixbuf = scaled.new_subpixbuf(
              cropX,
              cropY,
              cropWidth,
              cropHeight,
            );
          }
        }
      }
    } catch (e) {
      console.error(`FullscreenFadeGrid: unable to scale wallpaper: ${e}`);

      renderedPixbuf = pixbuf;
    }

    if (!renderedPixbuf) {
      return;
    }

    /*
     * Down-sample before uploading to GPU.  The wallpaper
     * is immediately blurred, so a quarter-resolution
     * texture is visually identical but uses ~16× less
     * memory and loads much faster.
     */
    const DPR = 4;
    const smallW = Math.max(1, Math.round(area.width / DPR));
    const smallH = Math.max(1, Math.round(area.height / DPR));
    const small = renderedPixbuf.scale_simple(
      smallW,
      smallH,
      GdkPixbuf.InterpType.BILINEAR,
    );
    if (small) {
      renderedPixbuf = small;
    }

    const content = new St.ImageContent({
      preferred_width: renderedPixbuf.get_width(),
      preferred_height: renderedPixbuf.get_height(),
    });

    try {
      const coglContext = global.stage.context.get_backend().get_cogl_context();

      const hasAlpha = renderedPixbuf.get_has_alpha();

      content.set_data(
        coglContext,
        renderedPixbuf.get_pixels(),
        hasAlpha ? Cogl.PixelFormat.RGBA_8888 : Cogl.PixelFormat.RGB_888,
        renderedPixbuf.get_width(),
        renderedPixbuf.get_height(),
        renderedPixbuf.get_rowstride(),
      );
    } catch (e) {
      console.error(
        `FullscreenFadeGrid: unable to create wallpaper texture: ${e}`,
      );
      return;
    }

    this._wallpaperActor = new Clutter.Actor({
      x: 0,
      y: 0,
      width: area.width,
      height: area.height,
      content,
      content_gravity: Clutter.ContentGravity.RESIZE_FILL,
      visible: true,
    });

    this._wallpaperActor.set_content_scaling_filters(
      Clutter.ScalingFilter.TRILINEAR,
      Clutter.ScalingFilter.LINEAR,
    );

    const blurEffect = new Shell.BlurEffect({
      mode: Shell.BlurMode.ACTOR,
      radius: WALLPAPER_BLUR_RADIUS,
      brightness: WALLPAPER_BRIGHTNESS,
    });

    this._wallpaperActor.add_effect(blurEffect);

    /*
     * Crucially, these go into the background container,
     * never directly into _overlay.
     */
    this._backgroundContainer.add_child(this._wallpaperActor);

    this._wallpaperDarkener = new St.Widget({
      style: `background-color: rgba(0, 0, 0, ${WALLPAPER_DARKNESS});`,
      reactive: false,
      x_expand: true,
      y_expand: true,
    });

    this._wallpaperDarkener.set_position(0, 0);
    this._wallpaperDarkener.set_size(area.width, area.height);

    this._backgroundContainer.add_child(this._wallpaperDarkener);
  },

  _connectWallpaperSettings() {
    this._disconnectWallpaperSettings();

    try {
      this._wallpaperSettings = new Gio.Settings({
        schema_id: "org.gnome.desktop.background",
      });

      this._wallpaperSettingsIds.push(
        this._wallpaperSettings.connect("changed::picture-uri", () =>
          this._refreshWallpaper(),
        ),
      );

      this._wallpaperSettingsIds.push(
        this._wallpaperSettings.connect("changed::picture-uri-dark", () =>
          this._refreshWallpaper(),
        ),
      );

      this._wallpaperSettingsIds.push(
        this._wallpaperSettings.connect("changed::picture-options", () =>
          this._refreshWallpaper(),
        ),
      );
    } catch (e) {
      console.error(
        `FullscreenFadeGrid: unable to monitor wallpaper settings: ${e}`,
      );
    }

    try {
      this._wallpaperInterfaceSettings = new Gio.Settings({
        schema_id: "org.gnome.desktop.interface",
      });

      this._wallpaperInterfaceSettingsIds.push(
        this._wallpaperInterfaceSettings.connect("changed::color-scheme", () =>
          this._refreshWallpaper(),
        ),
      );
    } catch (e) {
      this._wallpaperInterfaceSettings = null;
    }
  },

  _disconnectWallpaperSettings() {
    if (this._wallpaperSettings) {
      for (const id of this._wallpaperSettingsIds) {
        try {
          this._wallpaperSettings.disconnect(id);
        } catch (e) {
          // Already disconnected.
        }
      }
    }

    this._wallpaperSettingsIds = [];

    if (this._wallpaperInterfaceSettings) {
      for (const id of this._wallpaperInterfaceSettingsIds) {
        try {
          this._wallpaperInterfaceSettings.disconnect(id);
        } catch (e) {
          // Already disconnected.
        }
      }
    }

    this._wallpaperInterfaceSettingsIds = [];

    this._wallpaperSettings = null;
    this._wallpaperInterfaceSettings = null;
  },

  _refreshWallpaper() {
    if (
      !this._overlay ||
      !this._overlay.visible ||
      !this._backgroundContainer
    ) {
      return;
    }

    this._createWallpaperBackground(this._getUsableArea());
    this._lastWallpaperUri = this._getWallpaperUri();
  },

  _destroyWallpaperBackground() {
    if (this._wallpaperFallback) {
      this._wallpaperFallback.destroy();
      this._wallpaperFallback = null;
    }

    if (this._wallpaperActor) {
      this._wallpaperActor.destroy();
      this._wallpaperActor = null;
    }

    if (this._wallpaperDarkener) {
      this._wallpaperDarkener.destroy();
      this._wallpaperDarkener = null;
    }
  },

  _updateWallpaperBackground() {
    if (!this._overlay || !this._backgroundContainer) {
      return;
    }

    const area = this._getUsableArea();

    this._backgroundContainer.set_position(0, 0);
    this._backgroundContainer.set_size(area.width, area.height);

    if (!this._wallpaperActor) {
      this._createWallpaperBackground(area);
      return;
    }

    this._wallpaperActor.set_position(0, 0);
    this._wallpaperActor.set_size(area.width, area.height);

    if (this._wallpaperDarkener) {
      this._wallpaperDarkener.set_position(0, 0);

      this._wallpaperDarkener.set_size(area.width, area.height);
    }
  },
};
