import Clutter from "gi://Clutter";

const SWIPE_COMMIT_FRACTION = 0.5;
const TOUCH_START_THRESHOLD = 12;
const SWIPE_ANIMATION_DURATION = 180;

export const SwipeMixin = {
  _handleCapturedEvent(event) {
    if (!this._overlay || !this._overlay.visible) {
      return Clutter.EVENT_PROPAGATE;
    }

    const type = event.type();

    if (
      type === Clutter.EventType.TOUCH_BEGIN ||
      type === Clutter.EventType.TOUCH_UPDATE ||
      type === Clutter.EventType.TOUCH_END ||
      type === Clutter.EventType.TOUCH_CANCEL
    ) {
      return this._handleTouchEvent(event, type);
    }

    if (type === Clutter.EventType.BUTTON_PRESS) {
      // Handled per-button in _connectDragEvents.
      return Clutter.EVENT_PROPAGATE;
    }

    if (type === Clutter.EventType.BUTTON_RELEASE) {
      return this._handleDragRelease(event);
    }

    if (type === Clutter.EventType.MOTION) {
      return this._handleDragMotion(event);
    }

    if (type === Clutter.EventType.SCROLL) {
      return this._handleScrollEvent(event);
    }

    return Clutter.EVENT_PROPAGATE;
  },
  _handleTouchEvent(event, type) {
    const [x] = event.get_coords();

    if (type === Clutter.EventType.TOUCH_BEGIN) {
      // Don't set _swipeActive here. On touchpads,
      // TOUCH_BEGIN fires before BUTTON_PRESS. If we
      // set _swipeActive now, _onDragPress won't do anything.
      this._swipeType = "touch";
      this._swipeStartX = x;
      this._swipeOffset = 0;
      this._swipeTouchSequence = event.get_event_sequence();

      return Clutter.EVENT_PROPAGATE;
    }

    if (
      this._swipeType !== "touch" ||
      event.get_event_sequence() !== this._swipeTouchSequence
    ) {
      return Clutter.EVENT_PROPAGATE;
    }

    if (type === Clutter.EventType.TOUCH_UPDATE) {
      const rawOffset = x - this._swipeStartX;

      if (
        Math.abs(rawOffset) < TOUCH_START_THRESHOLD &&
        Math.abs(this._swipeOffset) < TOUCH_START_THRESHOLD
      ) {
        return Clutter.EVENT_PROPAGATE;
      }

      // Don't start swiping while a drag is in progress.
      if (this._dragItem) {
        return Clutter.EVENT_PROPAGATE;
      }

      if (!this._swipeActive) {
        this._swipeActive = true;
      }

      this._swipeOffset = this._applySwipeResistance(rawOffset);

      this._setInteractiveTranslation(this._swipeOffset);

      return Clutter.EVENT_STOP;
    }

    if (
      type === Clutter.EventType.TOUCH_END ||
      type === Clutter.EventType.TOUCH_CANCEL
    ) {
      this._finishSwipe();

      return Clutter.EVENT_STOP;
    }

    return Clutter.EVENT_PROPAGATE;
  },

  _handleScrollEvent(event) {
    let source;

    try {
      source = event.get_scroll_source();
    } catch (e) {
      source = Clutter.ScrollSource.UNKNOWN;
    }

    /*
     * Touchpad finger scrolling.
     */
    if (
      source === Clutter.ScrollSource.FINGER ||
      source === Clutter.ScrollSource.CONTINUOUS
    ) {
      let dx = 0;
      let dy = 0;

      try {
        [dx, dy] = event.get_scroll_delta();
      } catch (e) {
        return Clutter.EVENT_PROPAGATE;
      }

      if (Math.abs(dx) <= Math.abs(dy)) {
        return Clutter.EVENT_PROPAGATE;
      }

      if (!this._swipeActive) {
        this._swipeActive = true;
        this._swipeType = "scroll";
        this._swipeOffset = 0;
      }

      this._swipeOffset += -dx;

      this._swipeOffset = this._applySwipeResistance(this._swipeOffset);

      this._setInteractiveTranslation(this._swipeOffset);

      /*
       * A physical touchpad gesture generates a sequence of
       * smooth scroll events. We deliberately do not commit a
       * page until GNOME tells us that the scroll sequence has
       * finished.
       */
      let finishFlags = 0;

      try {
        finishFlags = event.get_scroll_finish_flags();
      } catch (e) {
        // Not available for this event.
      }

      if (finishFlags & Clutter.ScrollFinishFlags.HORIZONTAL) {
        this._finishSwipe();
      }

      return Clutter.EVENT_STOP;
    }

    /*
     * Ordinary mouse wheel.
     */
    const direction = event.get_scroll_direction();

    if (
      direction === Clutter.ScrollDirection.RIGHT ||
      direction === Clutter.ScrollDirection.DOWN
    ) {
      this._nextPage();
    } else if (
      direction === Clutter.ScrollDirection.LEFT ||
      direction === Clutter.ScrollDirection.UP
    ) {
      this._prevPage();
    }

    return Clutter.EVENT_STOP;
  },

  _applySwipeResistance(offset) {
    if (this._visiblePageCount <= 1) {
      return 0;
    }

    const width = this._pageWidth;

    if (width <= 0) {
      return 0;
    }

    const atFirst = this._currentPageIdx === 0;

    const atLast = this._currentPageIdx === this._visiblePageCount - 1;

    if (atFirst && offset > 0) {
      return offset * 0.25;
    }

    if (atLast && offset < 0) {
      return offset * 0.25;
    }

    return Math.max(-width, Math.min(width, offset));
  },

  _setInteractiveTranslation(offset) {
    if (!this._pagesContainer) {
      return;
    }

    const baseX = -this._currentPageIdx * this._pageWidth;

    this._pagesContainer.remove_all_transitions();

    this._pagesContainer.translation_x = baseX + offset;
  },

  _finishSwipe() {
    if (!this._swipeActive) {
      return;
    }

    const offset = this._swipeOffset;

    const width = this._pageWidth;

    this._swipeActive = false;
    this._swipeType = null;
    this._swipeStartX = 0;
    this._swipeOffset = 0;
    this._swipeTouchSequence = null;

    if (width <= 0) {
      this._setPageTranslation(this._currentPageIdx, true);
      return;
    }

    const commitDistance = width * SWIPE_COMMIT_FRACTION;

    if (
      offset <= -commitDistance &&
      this._currentPageIdx < this._visiblePageCount - 1
    ) {
      this._scrollToPage(this._currentPageIdx + 1, true);
      return;
    }

    if (offset >= commitDistance && this._currentPageIdx > 0) {
      this._scrollToPage(this._currentPageIdx - 1, true);
      return;
    }

    this._setPageTranslation(this._currentPageIdx, true);
  },

  _cancelSwipe() {
    this._swipeActive = false;
    this._swipeType = null;
    this._swipeStartX = 0;
    this._swipeOffset = 0;
    this._swipeTouchSequence = null;

    if (this._pagesContainer) {
      this._setPageTranslation(this._currentPageIdx, false);
    }
  },
};
