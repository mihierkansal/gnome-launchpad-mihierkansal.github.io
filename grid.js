import Clutter from "gi://Clutter";
import St from "gi://St";

const BUTTON_WIDTH = 140;
const BUTTON_HEIGHT = 135;
const COL_SPACING = 24;
const ROW_SPACING = 20;

const SWIPE_ANIMATION_DURATION = 300;

export const GridMixin = {
  _updateLayoutSizes() {
    if (!this._overlay || !this._pagesContainer) {
      return;
    }

    const area = this._getUsableArea();

    this._overlay.set_position(area.x, area.y);

    this._overlay.set_size(area.width, area.height);

    this._updateWallpaperBackground();

    const availableWidth = area.width - 160;

    const availableHeight = area.height - 260;

    this._pageWidth = area.width;
    this._availableWidth = availableWidth;

    this._availableHeight = availableHeight;

    this._maxCols = Math.max(
      6,
      Math.floor((availableWidth + COL_SPACING) / (BUTTON_WIDTH + COL_SPACING)),
    );

    this._maxRows = Math.max(
      4,
      Math.floor(
        (availableHeight + ROW_SPACING) / (BUTTON_HEIGHT + ROW_SPACING),
      ),
    );

    this._itemsPerPage = this._maxCols * this._maxRows;

    this._pitchX = availableWidth / this._maxCols;

    this._pitchY = availableHeight / this._maxRows;

    this._pages.forEach((page) => {
      page.set_size(area.width, availableHeight);
    });

    this._layoutVisibleItems();
  },

  _layoutVisibleItems() {
    const query = this._currentQuery;
    let matchIndex = 0;

    this._allItems.forEach((item) => {
      const matches = query === "" || item.name.includes(query);

      if (!matches) {
        item.actor.hide();
        return;
      }

      const pageIdx = Math.floor(matchIndex / this._itemsPerPage);

      const localIdx = matchIndex % this._itemsPerPage;

      item.col = localIdx % this._maxCols;

      item.row = Math.floor(localIdx / this._maxCols);

      item.pageIdx = pageIdx;

      const targetPage = this._getOrCreatePage(
        pageIdx,
        this._pageWidth,
        this._availableHeight,
      );

      const currentParent = item.actor.get_parent();

      if (currentParent !== targetPage) {
        if (currentParent) {
          currentParent.remove_child(item.actor);
        }

        targetPage.add_child(item.actor);
      }

      this._repositionItem(item);
      item.actor.show();

      matchIndex++;
    });

    this._visiblePageCount = Math.max(
      1,
      Math.ceil(matchIndex / this._itemsPerPage),
    );

    this._pages.forEach((page, idx) => {
      page.visible = idx < this._visiblePageCount;
    });

    this._currentPageIdx = Math.min(
      this._currentPageIdx,
      this._visiblePageCount - 1,
    );

    this._rebuildDots();

    this._setPageTranslation(this._currentPageIdx, false);
  },

  _cellX(col) {
    return (
      80 + col * this._pitchX + Math.max(0, (this._pitchX - BUTTON_WIDTH) / 2)
    );
  },

  _cellY(row) {
    return row * this._pitchY;
  },

  _repositionItem(item) {
    item.actor.set_position(this._cellX(item.col), this._cellY(item.row));
  },

  _getOrCreatePage(pageIdx, pageWidth, availableHeight) {
    let page = this._pages[pageIdx];

    if (page) {
      return page;
    }

    page = new St.Widget({
      layout_manager: new Clutter.FixedLayout(),
      x_expand: false,
      y_expand: true,
    });

    page.set_size(pageWidth, availableHeight);

    this._pagesContainer.add_child(page);

    this._pages.push(page);

    return page;
  },

  _nextPage() {
    if (this._currentPageIdx < this._visiblePageCount - 1) {
      this._scrollToPage(this._currentPageIdx + 1, true);
    }
  },

  _prevPage() {
    if (this._currentPageIdx > 0) {
      this._scrollToPage(this._currentPageIdx - 1, true);
    }
  },

  _setPageTranslation(index, animate) {
    if (!this._pagesContainer) {
      return;
    }

    const targetX = -(index * this._pageWidth);

    this._pagesContainer.ease({
      translation_x: targetX,
      duration: animate ? SWIPE_ANIMATION_DURATION : 0,
      mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
    });

    this._updateDots();
  },

  _scrollToPage(index, animate) {
    index = Math.max(0, Math.min(index, this._visiblePageCount - 1));

    this._currentPageIdx = index;

    this._setPageTranslation(index, animate);
  },

  _filterGrid(query) {
    this._currentQuery = query;

    let matchIndex = 0;

    this._allItems.forEach((item) => {
      const matches = item.name.includes(query);

      if (!matches) {
        item.actor.hide();
        return;
      }

      const pageIdx = Math.floor(matchIndex / this._itemsPerPage);

      const localIdx = matchIndex % this._itemsPerPage;

      item.col = localIdx % this._maxCols;

      item.row = Math.floor(localIdx / this._maxCols);

      item.pageIdx = pageIdx;

      const targetPage = this._getOrCreatePage(
        pageIdx,
        this._pageWidth,
        this._availableHeight,
      );

      const currentParent = item.actor.get_parent();

      if (currentParent !== targetPage) {
        if (currentParent) {
          currentParent.remove_child(item.actor);
        }

        targetPage.add_child(item.actor);
      }

      this._repositionItem(item);

      item.actor.show();

      matchIndex++;
    });

    this._visiblePageCount = Math.max(
      1,
      Math.ceil(matchIndex / this._itemsPerPage),
    );

    this._pages.forEach((page, idx) => {
      page.visible = idx < this._visiblePageCount;
    });

    this._currentPageIdx = 0;

    this._rebuildDots();

    this._setPageTranslation(0, false);
  },

  _launchFirstMatch() {
    const match = this._allItems.find((item) => item.actor.visible);

    if (match) {
      this._launchApp(match);
    }
  },

  _rebuildDots() {
    this._dotsContainer.destroy_all_children();
    this._dotInners = [];

    if (this._visiblePageCount <= 1) {
      this._dotsContainer.hide();
      return;
    }

    this._dotsContainer.show();

    for (let i = 0; i < this._visiblePageCount; i++) {
      const pageIdx = i;

      const dot = new St.Button({
        reactive: true,
        can_focus: false,
        style: `
                        width: 16px;
                        height: 16px;
                        border-radius: 11px;
                        background-color: transparent;
                        padding: 0;
                    `,
      });

      const dotInner = new St.Widget({
        style: `
                        width: 7px;
                        height: 7px;
                        border-radius: 4px;
                        background-color: rgba(255,255,255,0.2);
                    `,
        x_align: Clutter.ActorAlign.CENTER,
        y_align: Clutter.ActorAlign.CENTER,
      });
      dot.set_child(dotInner);

      /* 'clicked' fires for mouse clicks and touch taps alike
       * (St.Button's built-in click gesture handles touch). */
      dot.connect("clicked", () => {
        this._scrollToPage(pageIdx, true);
      });

      this._dotsContainer.add_child(dot);
      this._dotInners.push(dotInner);
    }

    this._updateSwipeDots(0);
  },

  /* Set dot opacities proportional to swipe progress.
   * progress > 0 means swiping toward the next page.
   * The current and target dots cross-fade between the
   * dim (0.2) and lit (0.8) states; alphas are clamped
   * to [0.2, 0.8] so no dot can ever vanish mid-swipe. */
  _updateSwipeDots(progress) {
    if (!this._dotInners || this._dotInners.length === 0) {
      return;
    }

    const page = Math.max(
      0,
      Math.min(this._currentPageIdx || 0, this._dotInners.length - 1),
    );
    const p = Math.max(-1, Math.min(1, Number(progress) || 0));

    this._dotInners.forEach((inner, i) => {
      let alpha = 0.2;

      if (i === page) {
        alpha = 0.8 - 0.6 * Math.abs(p);
      } else if (i === page + 1 && p > 0) {
        alpha = 0.2 + 0.6 * p;
      } else if (i === page - 1 && p < 0) {
        alpha = 0.2 + 0.6 * Math.abs(p);
      }

      alpha = Math.max(0.2, Math.min(0.8, alpha));

      inner.style = `
                        width: 7px;
                        height: 7px;
                        border-radius: 4px;
                        background-color: rgba(255,255,255,${alpha});
                    `;
    });
  },

  _updateDots() {
    this._rebuildDots();
  },
};
