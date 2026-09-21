import Clutter from "gi://Clutter";
import St from "gi://St";
import Gio from "gi://Gio";
import * as Main from "resource:///org/gnome/shell/ui/main.js";
import { Extension } from "resource:///org/gnome/shell/extensions/extension.js";

import { WallpaperMixin } from "./wallpaper.js";
import { SwipeMixin } from "./swipe.js";
import { GridMixin } from "./grid.js";
import Shell from "gi://Shell";
import { AppsMixin } from "./apps.js";
import { ReorderMixin } from "./reorder.js";

export default class FullscreenFadeGridExtension extends Extension {
  enable() {
    this._overlay = null;

    this._backgroundContainer = null;
    this._wallpaperActor = null;
    this._wallpaperDarkener = null;

    this._wallpaperSettings = null;
    this._wallpaperInterfaceSettings = null;
    this._wallpaperSettingsIds = [];
    this._wallpaperInterfaceSettingsIds = [];
    this._lastWallpaperUri = null;
    this._appSystemId = 0;

    this._searchEntry = null;
    this._pagesContainer = null;
    this._dotsContainer = null;
    this._mainBox = null;

    this._allItems = [];
    this._pages = [];

    this._currentPageIdx = 0;
    this._currentQuery = "";
    this._visiblePageCount = 1;

    this._stageResizeId = 0;
    this._monitorsChangedId = 0;
    this._capturedEventId = 0;

    this._maxCols = 6;
    this._maxRows = 4;
    this._itemsPerPage = this._maxCols * this._maxRows;

    this._availableWidth = 0;
    this._availableHeight = 0;
    this._pitchX = 0;
    this._pitchY = 0;

    this._swipeActive = false;
    this._swipeType = null;
    this._swipeStartX = 0;
    this._swipeOffset = 0;
    this._swipeTouchSequence = null;

    this._initReorder();

    this._dbusImpl = Gio.DBusExportedObject.wrapJSObject(
      `<node>
                <interface name="org.gnome.Shell.Extensions.FullscreenFadeGrid">
                    <method name="Toggle" />
                </interface>
            </node>`,
      this,
    );

    this._dbusImpl.export(
      Gio.DBus.session,
      "/org/gnome/Shell/Extensions/FullscreenFadeGrid",
    );
  }

  disable() {
    if (this._dbusImpl) {
      this._dbusImpl.unexport();
      this._dbusImpl = null;
    }

    this._disconnectWallpaperSettings();
    this._destroyOverlay();
    this._allItems = [];
  }

  Toggle() {
    if (this._overlay && this._overlay.visible) {
      this._hideOverlay();
    } else {
      this._showOverlay();
    }
  }

  _getUsableArea() {
    try {
      const idx = global.display.get_primary_monitor();
      const rect = global.display.get_monitor_geometry(idx);

      if (rect && rect.width > 0 && rect.height > 0) {
        return {
          x: rect.x,
          y: rect.y,
          width: rect.width,
          height: rect.height,
        };
      }
    } catch (e) {
      // Intentionally swallow.
    }

    const monitor = Main.layoutManager.primaryMonitor;

    if (monitor && monitor.width > 0 && monitor.height > 0) {
      return {
        x: monitor.x,
        y: monitor.y,
        width: monitor.width,
        height: monitor.height,
      };
    }

    return {
      x: 0,
      y: 0,
      width: global.stage.width || 1024,
      height: global.stage.height || 768,
    };
  }

  /*
   * ------------------------------------------------------------------
   * Overlay
   * ------------------------------------------------------------------
   */

  _showOverlay() {
    if (!this._overlay) {
      this._createOverlay();
    }

    this._currentQuery = "";
    this._currentPageIdx = 0;

    const uri = this._getWallpaperUri();
    if (uri !== this._lastWallpaperUri) {
      this._destroyWallpaperBackground();
      this._lastWallpaperUri = uri;
    }

    this._updateLayoutSizes();

    /* Restore any icons that were faded out during launch. */
    this._allItems.forEach((i) => {
      i.actor.opacity = 255;
      i.actor.scale_x = 1;
      i.actor.scale_y = 1;
      i.actor.set_pivot_point(0.5, 0.5);
    });

    this._overlay.opacity = 0;
    this._mainBox.scale_x = 1.1;
    this._mainBox.scale_y = 1.1;
    this._overlay.show();

    this._searchEntry.text = "";
    this._searchEntry.grab_key_focus();

    this._overlay.ease({
      opacity: 255,
      duration: 180,
      mode: Clutter.AnimationMode.EASE_OUT_QUAD,
    });

    this._mainBox.ease({
      scale_x: 1.0,
      scale_y: 1.0,
      duration: 180,
      mode: Clutter.AnimationMode.EASE_OUT_QUAD,
    });
  }

  _hideOverlay() {
    if (!this._overlay) {
      return;
    }

    this._cancelDrag();
    this._cancelSwipe();

    this._mainBox.ease({
      scale_x: 1.1,
      scale_y: 1.1,
      mode: Clutter.AnimationMode.EASE_OUT_QUAD,
    });
    this._overlay.ease({
      opacity: 0,
      duration: 120,
      mode: Clutter.AnimationMode.EASE_IN_QUAD,
      onComplete: () => {
        if (this._overlay) {
          this._overlay.hide();
        }

        global.stage.set_key_focus(null);
      },
    });
  }

  _launchApp(item) {
    if (!this._overlay) {
      item.launchFunc();
      return;
    }

    this._cancelDrag();
    this._cancelSwipe();

    const actor = item.actor;
    actor.set_pivot_point(0.5, 0.5);

    /*
     * Animate the icon itself: scale up + fade out,
     * then launch the app once the overlay has faded.
     */
    actor.ease({
      scale_x: 1.3,
      scale_y: 1.3,
      opacity: 0,
      duration: 200,
      mode: Clutter.AnimationMode.EASE_OUT_QUAD,
    });

    this._mainBox.ease({
      scale_x: 1.1,
      scale_y: 1.1,
      duration: 200,
      mode: Clutter.AnimationMode.EASE_OUT_QUAD,
    });

    this._overlay.ease({
      opacity: 0,
      duration: 200,
      mode: Clutter.AnimationMode.EASE_IN_QUAD,
      onComplete: () => {
        if (this._overlay) {
          this._overlay.hide();
        }

        global.stage.set_key_focus(null);
        item.launchFunc();
      },
    });
  }

  _createOverlay() {
    const area = this._getUsableArea();

    this._overlay = new St.Widget({
      layout_manager: new Clutter.BinLayout(),
      x_expand: true,
      y_expand: true,
      reactive: true,
      can_focus: true,
    });

    this._overlay.set_position(area.x, area.y);

    this._overlay.set_size(area.width, area.height);

    /*
     * This container is created once and remains the first child
     * of _overlay for the lifetime of the overlay.
     */
    this._backgroundContainer = new Clutter.Actor({
      x: 0,
      y: 0,
      width: area.width,
      height: area.height,
      reactive: false,
    });

    this._overlay.add_child(this._backgroundContainer);

    this._stageResizeId = global.stage.connect("notify::allocation", () => {
      if (this._overlay && this._overlay.visible) {
        this._updateLayoutSizes();
      }
    });

    this._monitorsChangedId = Main.layoutManager.connect(
      "monitors-changed",
      () => {
        if (this._overlay && this._overlay.visible) {
          this._updateLayoutSizes();
          this._refreshWallpaper();
        }
      },
    );

    this._connectWallpaperSettings();

    this._createWallpaperBackground(area);
    this._lastWallpaperUri = this._getWallpaperUri();

    this._appSystemId = Shell.AppSystem.get_default().connect(
      "installed-changed",
      () => this._onAppListChanged(),
    );

    /*
     * Everything below this point is added after the background
     * container and therefore remains visually above it.
     */
    this._mainBox = new St.BoxLayout({
      orientation: Clutter.Orientation.VERTICAL,
      x_expand: true,
      y_expand: true,
      clip_to_allocation: true,
      style: "spacing: 56px;",
    });
    this._mainBox.set_pivot_point(0.5, 0.5);

    const entryCenteringBox = new St.BoxLayout({
      orientation: Clutter.Orientation.HORIZONTAL,
      x_align: Clutter.ActorAlign.CENTER,
      x_expand: true,
      style: "margin-top: 28px;",
    });

    this._searchEntry = new St.Entry({
      hint_text: "Search applications...",
      can_focus: true,
      style_class: "search-entry",
      style:
        "width: 15em; " +
        "min-width: 15em; " +
        "max-width: 15em; " +
        "height: auto;",
    });

    this._searchEntry.clutter_text.connect("text-changed", () => {
      this._filterGrid(this._searchEntry.text.toLowerCase());
    });

    this._searchEntry.clutter_text.connect("activate", () => {
      this._launchFirstMatch();
    });

    this._searchEntry.clutter_text.connect(
      "key-press-event",
      (_actor, event) => {
        if (event.get_key_symbol() === Clutter.KEY_Tab) {
          const first = this._allItems.find((i) => i.actor.visible);
          if (first) {
            first.actor.grab_focus();
          }
          return Clutter.EVENT_STOP;
        }
        return Clutter.EVENT_PROPAGATE;
      },
    );

    entryCenteringBox.add_child(this._searchEntry);

    this._mainBox.add_child(entryCenteringBox);

    this._pagesContainer = new St.BoxLayout({
      orientation: Clutter.Orientation.HORIZONTAL,
      x_expand: true,
      y_expand: true,
    });

    this._mainBox.add_child(this._pagesContainer);

    this._dotsContainer = new St.BoxLayout({
      orientation: Clutter.Orientation.HORIZONTAL,
      x_align: Clutter.ActorAlign.CENTER,
      style:
        "spacing: 12px; " +
        "padding: 10px; " +
        "margin-bottom: 20px; " +
        "margin-left: 80px; " +
        "margin-right: 80px;",
    });

    this._mainBox.add_child(this._dotsContainer);

    this._loadApplications();
    this._applyOrder();
    this._connectDragEvents();

    this._overlay.add_child(this._mainBox);

    // During a button press the capture phase is
    // blocked, so captured-event never fires, so we use event.
    this._capturedEventId = this._overlay.connect("event", (_actor, event) =>
      this._handleCapturedEvent(event),
    );

    this._overlay.connect("key-press-event", (_actor, event) => {
      const symbol = event.get_key_symbol();

      if (symbol === Clutter.KEY_Escape) {
        this._hideOverlay();
        return Clutter.EVENT_STOP;
      }

      if (symbol === Clutter.KEY_Tab) {
        const first = this._allItems.find((i) => i.actor.visible);
        if (first) {
          first.actor.grab_key_focus();
        }
        return Clutter.EVENT_STOP;
      }

      return Clutter.EVENT_PROPAGATE;
    });

    Main.uiGroup.add_child(this._overlay);
  }

  /*
   * ------------------------------------------------------------------
   * Destruction
   * ------------------------------------------------------------------
   */

  _destroyOverlay() {
    if (this._stageResizeId) {
      global.stage.disconnect(this._stageResizeId);

      this._stageResizeId = 0;
    }

    if (this._monitorsChangedId) {
      Main.layoutManager.disconnect(this._monitorsChangedId);

      this._monitorsChangedId = 0;
    }

    if (this._appSystemId) {
      Shell.AppSystem.get_default().disconnect(this._appSystemId);
      this._appSystemId = 0;
    }

    if (this._overlay && this._capturedEventId) {
      this._overlay.disconnect(this._capturedEventId);

      this._capturedEventId = 0;
    }

    this._disconnectDragEvents();
    this._cancelSwipe();

    this._destroyWallpaperBackground();

    this._backgroundContainer = null;

    if (this._overlay) {
      Main.uiGroup.remove_child(this._overlay);

      this._overlay.destroy();
      this._overlay = null;
    }

    this._searchEntry = null;
    this._pagesContainer = null;
    this._dotsContainer = null;

    this._pages = [];
  }
}

Object.assign(
  FullscreenFadeGridExtension.prototype,
  WallpaperMixin,
  SwipeMixin,
  GridMixin,
  AppsMixin,
  ReorderMixin,
);
