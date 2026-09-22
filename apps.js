import Clutter from "gi://Clutter";
import St from "gi://St";
import Shell from "gi://Shell";
import Pango from "gi://Pango";

const BUTTON_WIDTH = 140;
const BUTTON_HEIGHT = 135;

export const AppsMixin = {
  _onAppListChanged() {
    this._allItems.forEach((item) => {
      if (item.actor.get_parent()) {
        item.actor.get_parent().remove_child(item.actor);
      }
      item.actor.destroy();
    });
    this._allItems = [];

    this._pages.forEach((page) => page.destroy());
    this._pages = [];

    this._loadApplications();
    this._applyOrder();
    this._saveOrder();
    this._connectDragEvents();
    this._currentPageIdx = 0;
    this._currentQuery = "";

    if (this._searchEntry) {
      this._searchEntry.text = "";
    }

    this._updateLayoutSizes();
  },

  _loadApplications() {
    const appSystem = Shell.AppSystem.get_default();

    const appList = appSystem.get_installed();

    const sortedApps = [];

    for (let i = 0; i < appList.length; i++) {
      const appInfo = appList[i];

      if (appInfo && appInfo.should_show()) {
        const wrappedApp = appSystem.lookup_app(appInfo.get_id());

        if (wrappedApp) {
          sortedApps.push({
            name: appInfo.get_name(),
            appId: appInfo.get_id(),
            wrappedApp,
          });
        }
      }
    }

    sortedApps.sort((a, b) =>
      a.name.toLowerCase().localeCompare(b.name.toLowerCase()),
    );

    sortedApps.forEach((appData) => {
      const appBtn = new St.Button({
        reactive: true,
        can_focus: true,
        track_hover: true,
        style: `
                            padding: 4px;
                            border-radius: 12px;
                            text-align: center;
                            background-color: transparent;
                        `,
      });

      appBtn.set_size(BUTTON_WIDTH, BUTTON_HEIGHT);

      // Remove the default ClutterClickGesture
      // so our button-press-event
      // handler works for click and drag.
      appBtn.clear_actions();

      const btnBox = new St.BoxLayout({
        orientation: Clutter.Orientation.VERTICAL,
        x_align: Clutter.ActorAlign.CENTER,
        y_align: Clutter.ActorAlign.START,
        x_expand: true,
        y_expand: true,
      });

      const icon = appData.wrappedApp.create_icon_texture(64);

      icon.set_x_align(Clutter.ActorAlign.CENTER);

      icon.set_y_align(Clutter.ActorAlign.START);

      const label = new St.Label({
        text: appData.name,
        style: `
                            color: white;
                            font-size: 10pt;
                            margin-top: 6px;
                            text-align: center;
                        `,
      });

      label.set_width(BUTTON_WIDTH - 10);

      label.clip_to_allocation = true;

      label.set_x_align(Clutter.ActorAlign.CENTER);

      label.set_y_align(Clutter.ActorAlign.START);

      label.clutter_text.set_line_wrap(false);

      label.clutter_text.set_single_line_mode(true);

      label.clutter_text.set_ellipsize(Pango.EllipsizeMode.END);

      /* Set centering directly on the ClutterText: relying on
       * the CSS 'text-align' alone leaves a frame where the
       * theme node is not yet re-resolved after a reparent,
       * and the text renders left-aligned (visible flicker
       * while icons are shuffled between pages). */
      label.clutter_text.set_line_alignment(Pango.Alignment.CENTER);

      btnBox.add_child(icon);
      btnBox.add_child(label);

      appBtn.set_child(btnBox);

      appBtn.connect("button-press-event", () => {
        appBtn.ease({
          scale_x: 0.92,
          scale_y: 0.92,
          opacity: 180,
          duration: 80,
          mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });
        return Clutter.EVENT_PROPAGATE;
      });

      appBtn.connect("button-release-event", () => {
        appBtn.ease({
          scale_x: 1.0,
          scale_y: 1.0,
          opacity: 255,
          duration: 80,
          mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });
        return Clutter.EVENT_PROPAGATE;
      });

      this._allItems.push({
        actor: appBtn,
        name: appData.name.toLowerCase(),
        appId: appData.appId,
        launchFunc: () => appData.wrappedApp.activate(),
        pageIdx: 0,
        col: 0,
        row: 0,
      });
    });
  },
};
