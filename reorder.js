import Clutter from "gi://Clutter";
import St from "gi://St";
import GLib from "gi://GLib";
import Gio from "gi://Gio";

const DRAG_THRESHOLD = 8;
const LIFT_SCALE = 1.08;
const LIFT_DURATION = 120;
const DROP_DURATION = 200;

function _getOrderDir() {
  return GLib.build_filenamev([GLib.get_user_config_dir(), "gnome-launchpad"]);
}

function _getOrderPath() {
  return GLib.build_filenamev([_getOrderDir(), "order.json"]);
}

export const ReorderMixin = {
  _initReorder() {
    this._dragActive = false;
    this._dragItem = null;
    this._dragStartRootX = 0;
    this._dragStartRootY = 0;
    this._dragOrigIdx = -1;
    this._dragCurrentIdx = -1;
    this._dragThresholdMet = false;
    this._dragPressTime = 0;
    this._dragOrigParent = null;
    this._dragOrigPos = [0, 0];
    this._dragOrigStagePos = [0, 0];
    this._dragOffsetX = 0;
    this._dragOffsetY = 0;
    this._lastEdgeScrollTime = 0;
    this._appOrder = this._loadOrder();
  },

  _loadOrder() {
    try {
      const path = _getOrderPath();
      const file = Gio.File.new_for_path(path);
      const [ok, contents] = file.load_contents(null);
      if (ok) {
        const text = new TextDecoder().decode(contents);
        const order = JSON.parse(text);
        if (Array.isArray(order)) return order;
      }
    } catch (_e) {}
    return [];
  },

  _saveOrder() {
    try {
      const dir = _getOrderDir();
      GLib.mkdir_with_parents(dir, 0o755);
      const order = this._allItems.map((item) => item.appId).filter(Boolean);
      const path = _getOrderPath();
      const file = Gio.File.new_for_path(path);
      file.replace_contents(
        JSON.stringify(order),
        null,
        false,
        Gio.FileCreateFlags.REPLACE_DESTINATION,
        null,
      );
    } catch (e) {
      logError(e, "GnomeLaunchpad: unable to save app order");
    }
  },

  _applyOrder() {
    if (this._appOrder.length === 0) return;
    const orderMap = new Map();
    this._appOrder.forEach((id, idx) => orderMap.set(id, idx));
    this._allItems.sort((a, b) => {
      const aIdx = orderMap.has(a.appId) ? orderMap.get(a.appId) : Infinity;
      const bIdx = orderMap.has(b.appId) ? orderMap.get(b.appId) : Infinity;
      return aIdx - bIdx;
    });
  },

  _stageToOverlay(stageX, stageY) {
    const [ovStageX, ovStageY] = this._overlay.get_transformed_position();
    return [stageX - ovStageX, stageY - ovStageY];
  },

  _cellStagePos(pageIdx, col, row) {
    const [pcStageX, pcStageY] =
      this._pagesContainer.get_transformed_position();
    return [
      pcStageX + pageIdx * this._pageWidth + this._cellX(col),
      pcStageY + this._cellY(row),
    ];
  },

  /**
   * Compute the target cell from the pointer position using
   * the grid layout.
   */
  _dropTargetIndex(stageX, stageY) {
    const [pcStageX, pcStageY] =
      this._pagesContainer.get_transformed_position();

    // Which page is the pointer over?
    const targetPage = Math.floor((stageX - pcStageX) / this._pageWidth);
    if (targetPage < 0 || targetPage >= this._pages.length) return -1;

    // Position within the page
    const pageLocalX = stageX - pcStageX - targetPage * this._pageWidth;
    const pageLocalY = stageY - pcStageY;

    // Convert to grid cell, clamped to valid range
    const col = Math.max(
      0,
      Math.min(
        Math.round((pageLocalX - this._cellX(0)) / this._pitchX),
        this._maxCols - 1,
      ),
    );
    const row = Math.max(
      0,
      Math.min(Math.floor(pageLocalY / this._pitchY), this._maxRows - 1),
    );

    // During drag, _currentQuery is always empty, so
    // _recomputePageSlots assigns sequential positions.
    let globalIdx = targetPage * this._itemsPerPage + row * this._maxCols + col;
    if (globalIdx < 0) return -1;

    // Clamp to the last valid item so the drag doesn't
    // lose its target at the edge of the grid.
    const lastIdx = this._allItems.length - 1;
    if (globalIdx > lastIdx) globalIdx = lastIdx;

    const item = this._allItems[globalIdx];
    if (!item || !item.actor.visible) return -1;
    if (item === this._dragItem) return -1;

    return globalIdx;
  },

  _connectDragEvents() {
    this._allItems.forEach((item) => {
      item._pressId = item.actor.connect(
        "button-press-event",
        (_actor, event) => this._onDragPress(item, event),
      );
    });
  },

  _disconnectDragEvents() {
    this._allItems.forEach((item) => {
      if (item._pressId) {
        try {
          item.actor.disconnect(item._pressId);
        } catch (_e) {}
        item._pressId = 0;
      }
    });
  },

  _onDragPress(item, event) {
    if (this._dragActive) return Clutter.EVENT_PROPAGATE;
    if (this._swipeActive) return Clutter.EVENT_PROPAGATE;

    const [rootX, rootY] = event.get_coords();
    this._dragItem = item;
    this._dragStartRootX = rootX;
    this._dragStartRootY = rootY;
    this._dragThresholdMet = false;
    this._dragPressTime = Date.now();
    this._dragOrigIdx = this._allItems.indexOf(item);
    this._dragCurrentIdx = this._dragOrigIdx;
    return Clutter.EVENT_STOP;
  },
  _handleDragMotion(event) {
    if (!this._dragItem) return Clutter.EVENT_PROPAGATE;
    if (this._currentQuery !== "") return Clutter.EVENT_PROPAGATE;
    const [rootX, rootY] = event.get_coords();

    if (!this._dragThresholdMet) {
      const dx = rootX - this._dragStartRootX;
      const dy = rootY - this._dragStartRootY;
      if (Math.abs(dx) < DRAG_THRESHOLD && Math.abs(dy) < DRAG_THRESHOLD)
        return Clutter.EVENT_STOP;
      this._dragThresholdMet = true;
      this._dragActive = true;
      this._startDragLift(rootX, rootY);
    }

    this._updateDragPosition(rootX, rootY);
    return Clutter.EVENT_STOP;
  },

  _handleDragRelease(event) {
    if (!this._dragItem) return Clutter.EVENT_PROPAGATE;
    if (!this._dragThresholdMet) {
      const elapsed = Date.now() - this._dragPressTime;
      const item = this._dragItem;
      this._dragItem = null;
      if (elapsed < 400) {
        this._launchApp(item);
      }
      return Clutter.EVENT_STOP;
    }
    this._endDrag();
    return Clutter.EVENT_STOP;
  },

  _startDragLift(firstRootX, firstRootY) {
    const actor = this._dragItem.actor;
    const parent = actor.get_parent();
    this._dragOrigParent = parent;
    this._dragOrigPos = [actor.x, actor.y];
    const [asx, asy] = actor.get_transformed_position();
    this._dragOrigStagePos = [asx, asy];
    this._dragOffsetX = asx - firstRootX;
    this._dragOffsetY = asy - firstRootY;
    parent.set_child_above_sibling(actor, null);
    actor.ease({
      scale_x: LIFT_SCALE,
      scale_y: LIFT_SCALE,
      duration: LIFT_DURATION,
      mode: Clutter.AnimationMode.EASE_OUT_QUAD,
    });
  },

  _updateDragPosition(rootX, rootY) {
    const actor = this._dragItem.actor;
    const parent = actor.get_parent();
    const [psx, psy] = parent.get_transformed_position();
    actor.set_position(
      rootX + this._dragOffsetX - psx,
      rootY + this._dragOffsetY - psy,
    );

    this._checkEdgeScroll(rootX, rootY);

    const newIdx = this._dropTargetIndex(rootX, rootY);

    if (newIdx >= 0 && newIdx !== this._dragCurrentIdx) {
      this._dragCurrentIdx = this._reflow(this._dragCurrentIdx, newIdx);
    }
  },

  _checkEdgeScroll(rootX, rootY) {
    const EDGE_ZONE = 100;
    const EDGE_COOLDOWN = 400;
    const now = Date.now();
    if (now - this._lastEdgeScrollTime < EDGE_COOLDOWN) return;

    const [ovX] = this._stageToOverlay(rootX, rootY);
    const area = this._getUsableArea();
    let tp = this._currentPageIdx;
    if (ovX < EDGE_ZONE && tp > 0) tp--;
    else if (ovX > area.width - EDGE_ZONE && tp < this._visiblePageCount - 1)
      tp++;

    if (tp !== this._currentPageIdx) {
      this._lastEdgeScrollTime = now;
      this._currentPageIdx = tp;
      this._setPageTranslation(tp, true);
    }
  },

  _reflow(fromIdx, toIdx) {
    if (fromIdx === toIdx) return toIdx;
    const [item] = this._allItems.splice(fromIdx, 1);
    this._allItems.splice(toIdx, 0, item);
    this._recomputePageSlots();

    const draggedActor = this._dragItem ? this._dragItem.actor : null;

    this._allItems.forEach((i) => {
      if (!i.actor.visible) return;
      const tp = this._getOrCreatePage(
        i.pageIdx,
        this._pageWidth,
        this._availableHeight,
      );
      if (i.actor.get_parent() !== tp) {
        const cp = i.actor.get_parent();
        if (cp) cp.remove_child(i.actor);
        tp.add_child(i.actor);
      }
      if (i.actor !== draggedActor) {
        i.actor.ease({
          x: this._cellX(i.col),
          y: this._cellY(i.row),
          duration: 120,
          mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });
      }
    });

    if (draggedActor && draggedActor.get_parent())
      draggedActor.get_parent().set_child_above_sibling(draggedActor, null);

    this._updateDots();
    return toIdx;
  },

  _recomputePageSlots() {
    const query = this._currentQuery;
    let mi = 0;
    this._allItems.forEach((item) => {
      if (query !== "" && !item.name.includes(query)) return;
      const pi = Math.floor(mi / this._itemsPerPage);
      const li = mi % this._itemsPerPage;
      item.col = li % this._maxCols;
      item.row = Math.floor(li / this._maxCols);
      item.pageIdx = pi;
      mi++;
    });
  },

  _endDrag() {
    const actor = this._dragItem.actor;
    const origPage = this._dragOrigParent;
    const ti = this._dragCurrentIdx;
    const tp = Math.floor(ti / this._itemsPerPage);
    const li = ti % this._itemsPerPage;
    const tc = li % this._maxCols;
    const tr = Math.floor(li / this._maxCols);
    const tpa = this._pages[tp] || origPage;
    const [tsx, tsy] = this._cellStagePos(tp, tc, tr);
    const cp = actor.get_parent();
    const [psx, psy] = cp.get_transformed_position();

    actor.ease({
      x: tsx - psx,
      y: tsy - psy,
      scale_x: 1,
      scale_y: 1,
      duration: DROP_DURATION,
      mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
      onComplete: () => {
        if (cp !== tpa) {
          cp.remove_child(actor);
          tpa.add_child(actor);
        }
        actor.set_position(this._cellX(tc), this._cellY(tr));
        actor.translation_x = 0;
        actor.translation_y = 0;
        this._saveOrder();
      },
    });
    this._dragActive = false;
    this._dragItem = null;
  },

  _cancelDrag() {
    if (!this._dragItem) return;
    const actor = this._dragItem.actor;
    if (!this._dragThresholdMet) {
      this._dragItem = null;
      return;
    }
    actor.ease({
      x: this._dragOrigPos[0],
      y: this._dragOrigPos[1],
      scale_x: 1,
      scale_y: 1,
      duration: 120,
      mode: Clutter.AnimationMode.EASE_OUT_QUAD,
      onComplete: () => this._layoutVisibleItems(),
    });
    this._dragActive = false;
    this._dragItem = null;
  },
};
