import Clutter from "gi://Clutter";

const TOUCH_START_THRESHOLD = 12;

/* Tap detection: a finger that lifted quickly and barely
 * moved is a tap, not a swipe. */
const TAP_MAX_DISTANCE = 20;
const TAP_MAX_DURATION = 500;

/* Scroll deltas are fractional; scale them to produce
 * proportional pixel movement.  Higher = slower. */
const SCROLL_SCALE = 26;

/* Cooldown between consecutive swipe gestures. */
const SWIPE_COOLDOWN_MS = 150;

/* A fast flick commits even if the distance threshold
 * wasn't reached.  Velocity is computed from the events
 * in the final FLICK_WINDOW_MS before finger lift. */
const FLICK_WINDOW_MS = 120;
const FLICK_VELOCITY = 0.5; /* px per ms */
const FLICK_MIN_OFFSET = 20;

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
      if (this._swipeActive) {
        this._finishSwipe();
      }
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

  /* True when the finger barely moved and lifted quickly:
   * that is a tap, not a swipe. */
  _isTap(x, y) {
    if (this._touchCancelled) {
      return false;
    }

    const dx = x - this._touchDownX;
    const dy = y - this._touchDownY;
    const dist = Math.sqrt(dx * dx + dy * dy);

    return (
      dist < TAP_MAX_DISTANCE &&
      Date.now() - this._touchDownTime < TAP_MAX_DURATION
    );
  },

  /* Find the app icon (if any) under the given stage coords. */
  _findItemAt(x, y) {
    const picked = global.stage.get_actor_at_pos(
      Clutter.PickMode.REACTIVE,
      x,
      y,
    );

    if (!picked) {
      return null;
    }

    for (let actor = picked; actor; actor = actor.get_parent()) {
      const item = this._allItems.find((i) => i.actor === actor);

      if (item) {
        return item;
      }
    }

    return null;
  },

  _handleTouchEvent(event, type) {
    const [x, y] = event.get_coords();

    if (type === Clutter.EventType.TOUCH_BEGIN) {
      this._touchCount += 1;

      if (this._touchCount > 1) {
        /* Second finger: the gesture becomes ambiguous and is
         * definitely not a tap. */
        this._touchMulti = true;
        return Clutter.EVENT_PROPAGATE;
      }

      this._touchMulti = false;
      this._touchDownX = x;
      this._touchDownY = y;
      this._touchDownTime = Date.now();
      this._touchCancelled = false;
      this._swipeType = "touch";
      this._swipeStartX = x;
      this._swipeLastTouchX = x;
      this._swipeOffset = 0;
      this._scrollReceived = false;
      this._swipeScrollEvents = [];

      if (this._swipeActive) {
        this._finishSwipe();
      }

      /* Propagate so the press is delivered to icons under the
       * finger (needed for presses while over an icon). */
      return Clutter.EVENT_PROPAGATE;
    }

    if (
      type === Clutter.EventType.TOUCH_END ||
      type === Clutter.EventType.TOUCH_CANCEL
    ) {
      if (type === Clutter.EventType.TOUCH_CANCEL) {
        this._touchCancelled = true;
      }

      if (this._touchCount > 0) {
        this._touchCount -= 1;
      }

      this._swipeType = null;

      const gestureEnded = this._touchCount === 0;

      if (this._swipeActive && gestureEnded) {
        this._finishSwipe();
        return Clutter.EVENT_STOP;
      }

      /* A clean single-finger tap: launch the icon under the
       * finger, or focus the search entry. */
      if (
        gestureEnded &&
        !this._touchMulti &&
        !this._touchCancelled &&
        this._isTap(x, y)
      ) {
        if (this._dragItem && this._dragActive) {
          this._cancelDrag();
          return Clutter.EVENT_STOP;
        }

        const item = this._findItemAt(x, y);

        if (item) {
          this._launchApp(item);
          return Clutter.EVENT_STOP;
        }

        /* Focus the search entry when tapping empty space or the
         * entry itself; taps on the dots fall through to the
         * dots' own 'clicked' handlers. */
        const picked = global.stage.get_actor_at_pos(
          Clutter.PickMode.REACTIVE,
          x,
          y,
        );

        let onSearch = false;

        for (let a = picked; a; a = a.get_parent()) {
          if (a === this._searchEntry) {
            onSearch = true;
            break;
          }
        }

        if ((picked === this._overlay || onSearch) && this._searchEntry) {
          this._searchEntry.grab_key_focus();
        }
      }

      return Clutter.EVENT_PROPAGATE;
    }

    if (type !== Clutter.EventType.TOUCH_UPDATE) {
      return Clutter.EVENT_PROPAGATE;
    }

    /* Ignore updates from other fingers or after gesture end. */
    if (this._touchMulti || this._touchCount === 0) {
      return Clutter.EVENT_PROPAGATE;
    }

    /* Once a trackpad scroll sequence owns the gesture,
     * touch updates are redundant. */
    if (this._scrollReceived) {
      return Clutter.EVENT_PROPAGATE;
    }

    const rawOffset = x - this._swipeStartX;

    /* Track movement (pixels) for flick velocity, even
     * below the activation threshold. */
    this._swipeScrollEvents.push({
      dpx: x - this._swipeLastTouchX,
      time: Date.now(),
    });
    this._swipeLastTouchX = x;

    const aboveThreshold =
      Math.abs(rawOffset) >= TOUCH_START_THRESHOLD ||
      Math.abs(this._swipeOffset) >= TOUCH_START_THRESHOLD;

    if (!aboveThreshold) {
      return Clutter.EVENT_PROPAGATE;
    }

    this._touchCancelled = true;

    if (this._dragItem) {
      const actor = this._dragItem.actor;
      this._cancelDrag();
      actor.ease({
        scale_x: 1,
        scale_y: 1,
        opacity: 255,
        duration: 80,
        mode: Clutter.AnimationMode.EASE_OUT_QUAD,
      });
    }

    if (!this._swipeActive) {
      this._swipeActive = true;
    }

    this._swipeOffset = this._clampSwipeOffset(rawOffset);
    this._setInteractiveTranslation(this._swipeOffset);

    return Clutter.EVENT_STOP;
  },

  _handleScrollEvent(event) {
    let source;

    try {
      source = event.get_scroll_source();
    } catch (e) {
      source = Clutter.ScrollSource.UNKNOWN;
    }

    if (
      this._swipeActive &&
      source !== Clutter.ScrollSource.FINGER &&
      source !== Clutter.ScrollSource.CONTINUOUS
    ) {
      this._finishSwipe();
    }

    /* Touchpad finger scrolling. */
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

      let finishFlags = 0;

      try {
        finishFlags = event.get_scroll_finish_flags();
      } catch (e) {
        // Not available on this event.
      }

      const ended =
        (finishFlags &
          (Clutter.ScrollFinishFlags.HORIZONTAL |
            Clutter.ScrollFinishFlags.VERTICAL)) !==
        0;

      if (!this._swipeActive) {
        /* Stray end event with no gesture in progress. */
        if (ended) {
          return Clutter.EVENT_PROPAGATE;
        }

        /* Gesture start: only claim clearly-horizontal scrolls. */
        if (Math.abs(dx) <= Math.abs(dy)) {
          return Clutter.EVENT_PROPAGATE;
        }

        /* Reject new gestures during cooldown. */
        if (
          this._swipeFinishTime &&
          Date.now() - this._swipeFinishTime < SWIPE_COOLDOWN_MS
        ) {
          return Clutter.EVENT_STOP;
        }

        this._swipeActive = true;
        this._swipeType = "scroll";
        this._swipeOffset = 0;
        this._swipeScrollEvents = [];
      }

      /* Gesture active: apply deltas (including vertical ones,
       * as GNOME does once a horizontal gesture has begun). */
      const dpx = (-dx * this._pageWidth) / SCROLL_SCALE;
      this._scrollReceived = true;
      this._swipeOffset += dpx;
      this._swipeOffset = this._clampSwipeOffset(this._swipeOffset);
      this._setInteractiveTranslation(this._swipeOffset);

      this._swipeScrollEvents.push({ dpx, time: Date.now() });
      if (this._swipeScrollEvents.length > 12) {
        this._swipeScrollEvents.shift();
      }

      if (ended) {
        this._finishSwipe();
      }

      return Clutter.EVENT_STOP;
    }

    /* Ordinary mouse wheel. */
    const direction = event.get_scroll_direction();

    if (
      direction === Clutter.ScrollDirection.RIGHT ||
      direction === Clutter.ScrollDirection.DOWN
    ) {
      this._nextPage();
      if (typeof this._onPageChangedDuringDrag === "function") {
        this._onPageChangedDuringDrag();
      }
    } else if (
      direction === Clutter.ScrollDirection.LEFT ||
      direction === Clutter.ScrollDirection.UP
    ) {
      this._prevPage();
      if (typeof this._onPageChangedDuringDrag === "function") {
        this._onPageChangedDuringDrag();
      }
    }

    return Clutter.EVENT_STOP;
  },

  _getSwipeVelocity() {
    const events = this._swipeScrollEvents;
    if (events.length < 2) {
      return 0;
    }

    const last = events[events.length - 1];
    const recent = events.filter((e) => last.time - e.time <= FLICK_WINDOW_MS);

    if (recent.length < 2) {
      return 0;
    }

    const dt = recent[recent.length - 1].time - recent[0].time;
    if (dt <= 0) {
      return 0;
    }

    /* Deltas are already stored in pixels. */
    const totalPx = recent.reduce((sum, e) => sum + e.dpx, 0);

    return totalPx / dt;
  },

  _clampSwipeOffset(offset) {
    if (this._visiblePageCount <= 1) {
      return 0;
    }

    const width = this._pageWidth;

    if (width <= 0) {
      return 0;
    }

    const atFirst = this._currentPageIdx === 0;
    const atLast = this._currentPageIdx === this._visiblePageCount - 1;

    /* Hard stop at the first/last page: no overscroll, so the
     * edge of the grid is exactly where it looks like it is. */
    if (atFirst && offset > 0) {
      return 0;
    }

    if (atLast && offset < 0) {
      return 0;
    }

    /* Between pages, never show more than one page of travel:
     * overscrolling past -width would reveal the page beyond
     * the next one, making the last page look closer than it is. */
    return Math.max(-width, Math.min(width, offset));
  },

  _setInteractiveTranslation(offset) {
    if (!this._pagesContainer) {
      return;
    }

    const baseX = -this._currentPageIdx * this._pageWidth;

    this._pagesContainer.remove_all_transitions();
    this._pagesContainer.translation_x = baseX + offset;

    const progress = -offset / this._pageWidth;
    if (typeof this._updateSwipeDots === "function") {
      this._updateSwipeDots(progress);
    }
  },

  _finishSwipe() {
    if (!this._swipeActive) {
      return;
    }

    const offset = this._swipeOffset;
    const width = this._pageWidth;
    const velocity = this._getSwipeVelocity();

    this._swipeActive = false;
    this._swipeType = null;
    this._swipeStartX = 0;
    this._swipeOffset = 0;
    this._swipeTouchSequence = null;
    this._scrollReceived = false;
    this._swipeScrollEvents = [];
    this._swipeFinishTime = Date.now();

    if (width <= 0) {
      this._setPageTranslation(this._currentPageIdx, true);
      return;
    }

    const commitDistance = width * 0.2;

    /* Distance-based commit. */
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

    /* Velocity-based commit for fast flicks that stopped
     * short of the distance threshold. */
    if (
      velocity < -FLICK_VELOCITY &&
      Math.abs(offset) > FLICK_MIN_OFFSET &&
      this._currentPageIdx < this._visiblePageCount - 1
    ) {
      this._scrollToPage(this._currentPageIdx + 1, true);
      return;
    }

    if (
      velocity > FLICK_VELOCITY &&
      Math.abs(offset) > FLICK_MIN_OFFSET &&
      this._currentPageIdx > 0
    ) {
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
    this._scrollReceived = false;
    this._swipeScrollEvents = [];

    if (this._pagesContainer) {
      this._setPageTranslation(this._currentPageIdx, false);
    }
  },
};
