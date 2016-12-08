/**
 * Copyright 2015 The AMP HTML Authors. All Rights Reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS-IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import {Observable} from '../observable';
import {findIndex} from '../utils/array';
import {documentStateFor} from './document-state';
import {getServiceForDoc} from '../service';
import {dev} from '../log';
import {
  getSourceUrl,
  parseQueryString,
  parseUrl,
  removeFragment,
  isProxyOrigin,
} from '../url';
import {timerFor} from '../timer';
import {reportError} from '../error';
import {VisibilityState} from '../visibility-state';
import {tryParseJson} from '../json';

const TAG_ = 'Viewer';
const SENTINEL_ = '__AMP__';

/**
 * Duration in milliseconds to wait for viewerOrigin to be set before an empty
 * string is returned.
 * @const
 * @private {number}
 */
const VIEWER_ORIGIN_TIMEOUT_ = 1000;

/**
 * These domains are trusted with more sensitive viewer operations such as
 * propagating the referrer. If you believe your domain should be here,
 * file the issue on GitHub to discuss. The process will be similar
 * (but somewhat more stringent) to the one described in the [3p/README.md](
 * https://github.com/ampproject/amphtml/blob/master/3p/README.md)
 *
 * @export {!Array<!RegExp>}
 */
const TRUSTED_VIEWER_HOSTS = [
  /**
   * Google domains, including country-codes and subdomains:
   * - google.com
   * - www.google.com
   * - google.co
   * - www.google.co
   * - google.az
   * - www.google.az
   * - google.com.az
   * - www.google.com.az
   * - google.co.az
   * - www.google.co.az
   * - google.cat
   * - www.google.cat
   */
  /(^|\.)google\.(com?|[a-z]{2}|com?\.[a-z]{2}|cat)$/,
];


/**
 * An AMP representation of the Viewer. This class doesn't do any work itself
 * but instead delegates everything to the actual viewer. This class and the
 * actual Viewer are connected via "AMP.viewer" using three methods:
 * {@link getParam}, {@link receiveMessage} and {@link setMessageDeliverer}.
 * @package Visible for type.
 */
export class Viewer {

  /**
   * @param {!./ampdoc-impl.AmpDoc} ampdoc
   * @param {!Object<string, string>=} opt_initParams
   */
  constructor(ampdoc, opt_initParams) {
    /** @const {!./ampdoc-impl.AmpDoc} */
    this.ampdoc = ampdoc;

    /** @const {!Window} */
    this.win = ampdoc.win;

    /** @private @const {boolean} */
    this.isIframed_ = (this.win.parent && this.win.parent != this.win);

    /** @const {!./document-state.DocumentState} */
    this.docState_ = documentStateFor(this.win);

    /** @private {boolean} */
    this.isRuntimeOn_ = true;

    /** @private {boolean} */
    this.overtakeHistory_ = false;

    /** @private {!VisibilityState} */
    this.visibilityState_ = VisibilityState.VISIBLE;

    /** @private {string} */
    this.viewerVisibilityState_ = this.visibilityState_;

    /** @private {number} */
    this.prerenderSize_ = 1;

    /** @private {number} */
    this.paddingTop_ = 0;

    /** @private {?Observable<boolean>} */
    this.runtimeOnObservable_ = null;

    /** @private {?Observable} */
    this.visibilityObservable_ = null;

    /** @private {?Observable<!JSONType>} */
    this.viewportObservable_ = null;

    /** @private {?Observable<!ViewerHistoryPoppedEventDef>} */
    this.historyPoppedObservable_ = null;

    /** @private {?Observable<!JSONType>} */
    this.broadcastObservable_ = null;

    /** @private {?function(string, *, boolean):(Promise<*>|undefined)} */
    this.messageDeliverer_ = null;

    /** @private {?string} */
    this.messagingOrigin_ = null;

    /**
     * @private {!Array<!{
     *   eventType: string,
     *   data: *,
     *   awaitResponse: boolean,
     *   responsePromise: (Promise<*>|undefined),
     *   responseResolver: function(*)
     * }>}
     */
    this.messageQueue_ = [];

    /** @const @private {!Object<string, string>} */
    this.params_ = {};

    /** @private {?function()} */
    this.whenFirstVisibleResolve_ = null;

    /** @private {?time} */
    this.firstVisibleTime_ = null;

    /** @private {?Function} */
    this.messagingReadyResolver_ = null;

    /** @private {?Function} */
    this.viewerOriginResolver_ = null;

    /** @private {?Function} */
    this.trustedViewerResolver_ = null;

    /**
     * This promise might be resolved right away if the current
     * document is already visible. See end of this constructor where we call
     * `this.onVisibilityChange_()`.
     * @private @const {!Promise}
     */
    this.whenFirstVisiblePromise_ = new Promise(resolve => {
      this.whenFirstVisibleResolve_ = resolve;
    });

    // Params can be passed either directly in multi-doc environment or via
    // iframe hash/name with hash taking precedence.
    if (opt_initParams) {
      Object.assign(this.params_, opt_initParams);
    } else {
      if (this.win.name && this.win.name.indexOf(SENTINEL_) == 0) {
        parseParams_(this.win.name.substring(SENTINEL_.length), this.params_);
      }
      if (this.win.location.hash) {
        parseParams_(this.win.location.hash, this.params_);
      }
    }

    dev().fine(TAG_, 'Viewer params:', this.params_);

    this.isRuntimeOn_ = !parseInt(this.params_['off'], 10);
    dev().fine(TAG_, '- runtimeOn:', this.isRuntimeOn_);

    this.overtakeHistory_ = !!(parseInt(this.params_['history'], 10) ||
        this.overtakeHistory_);
    dev().fine(TAG_, '- history:', this.overtakeHistory_);

    this.setVisibilityState_(this.params_['visibilityState']);
    dev().fine(TAG_, '- visibilityState:', this.getVisibilityState());

    this.prerenderSize_ = parseInt(this.params_['prerenderSize'], 10) ||
        this.prerenderSize_;
    dev().fine(TAG_, '- prerenderSize:', this.prerenderSize_);

    this.paddingTop_ = parseInt(this.params_['paddingTop'], 10) ||
        this.paddingTop_;
    dev().fine(TAG_, '- padding-top:', this.paddingTop_);

    /**
     * Whether the AMP document is embedded in a webview.
     * @private @const {boolean}
     */
    this.isWebviewEmbedded_ = !this.isIframed_ &&
        this.params_['webview'] == '1';

    /**
     * Whether the AMP document is embedded in a viewer, such as an iframe, or
     * a web view, or a shadow doc in PWA.
     * @private @const {boolean}
     */
    this.isEmbedded_ = !!(
        this.isIframed_ && !this.win.AMP_TEST_IFRAME
        // Checking param "origin", as we expect all viewers to provide it.
        // See https://github.com/ampproject/amphtml/issues/4183
        // There appears to be a bug under investigation where the
        // origin is sometimes failed to be detected. Since failure mode
        // if we fail to initialize communication is very bad, we also check
        // for visibilityState.
        // After https://github.com/ampproject/amphtml/issues/6070
        // is fixed we should probably only keep the amp_js_v check here.
        && (this.params_['origin']
            || this.params_['viewerorigin']
            || this.params_['visibilityState']
            // Parent asked for viewer JS. We must be embedded.
            || (this.win.location.search.indexOf('amp_js_v') != -1))
        || this.isWebviewEmbedded_
        || !ampdoc.isSingleDoc());

    /** @private {boolean} */
    this.hasBeenVisible_ = this.isVisible();

    // Wait for document to become visible.
    this.docState_.onVisibilityChanged(this.recheckVisibilityState_.bind(this));

    /**
     * This promise will resolve when communications channel has been
     * established or timeout in 20 seconds. The timeout is needed to avoid
     * this promise becoming a memory leak with accumulating undelivered
     * messages. The promise is only available when the document is embedded.
     * @private @const {?Promise}
     */
    this.messagingReadyPromise_ = this.isEmbedded_ ?
        timerFor(this.win).timeoutPromise(
            20000,
            new Promise(resolve => {
              this.messagingReadyResolver_ = resolve;
            })).catch(reason => {
              throw getChannelError(/** @type {!Error|string|undefined} */ (
                  reason));
            }) : null;

    /**
     * A promise for non-essential messages. These messages should not fail
     * if there's no messaging channel set up. But ideally viewer would try to
     * deliver if at all possible. This promise is only available when the
     * document is embedded.
     * @private @const {?Promise}
     */
    this.messagingMaybePromise_ = this.isEmbedded_ ?
        this.messagingReadyPromise_
            .catch(reason => {
              // Don't fail promise, but still report.
              reportError(getChannelError(
                  /** @type {!Error|string|undefined} */ (reason)));
            }) : null;

    // Trusted viewer and referrer.
    let trustedViewerResolved;
    let trustedViewerPromise;
    if (!this.isEmbedded_) {
      // Not embedded in IFrame - can't trust the viewer.
      trustedViewerResolved = false;
      trustedViewerPromise = Promise.resolve(false);
    } else if (this.win.location.ancestorOrigins && !this.isWebviewEmbedded_) {
      // Ancestors when available take precedence. This is the main API used
      // for this determination. Fallback is only done when this API is not
      // supported by the browser.
      trustedViewerResolved = (this.win.location.ancestorOrigins.length > 0 &&
          this.isTrustedViewerOrigin_(this.win.location.ancestorOrigins[0]));
      trustedViewerPromise = Promise.resolve(trustedViewerResolved);
    } else {
      // Wait for comms channel to confirm the origin.
      trustedViewerResolved = undefined;
      trustedViewerPromise = new Promise(resolve => {
        this.trustedViewerResolver_ = resolve;
      });
    }

    /** @const @private {!Promise<boolean>} */
    this.isTrustedViewer_ = trustedViewerPromise;

    /** @const @private {!Promise<string>} */
    this.viewerOrigin_ = new Promise(resolve => {
      if (!this.isEmbedded()) {
        // Viewer is only determined for iframed documents at this time.
        resolve('');
      } else if (this.win.location.ancestorOrigins &&
          this.win.location.ancestorOrigins.length > 0) {
        resolve(this.win.location.ancestorOrigins[0]);
      } else {
        // Race to resolve with a timer.
        timerFor(this.win).delay(() => resolve(''), VIEWER_ORIGIN_TIMEOUT_);
        this.viewerOriginResolver_ = resolve;
      }
    });

    /** @private {string} */
    this.unconfirmedReferrerUrl_ =
        this.isEmbedded() && 'referrer' in this.params_ &&
            trustedViewerResolved !== false ?
        this.params_['referrer'] :
        this.win.document.referrer;

    /** @const @private {!Promise<string>} */
    this.referrerUrl_ = new Promise(resolve => {
      if (this.isEmbedded() && 'referrer' in this.params_) {
        // Viewer override, but only for whitelisted viewers. Only allowed for
        // iframed documents.
        this.isTrustedViewer_.then(isTrusted => {
          if (isTrusted) {
            resolve(this.params_['referrer']);
          } else {
            resolve(this.win.document.referrer);
            if (this.unconfirmedReferrerUrl_ != this.win.document.referrer) {
              dev().error(TAG_, 'Untrusted viewer referrer override: ' +
                  this.unconfirmedReferrerUrl_ + ' at ' +
                  this.messagingOrigin_);
              this.unconfirmedReferrerUrl_ = this.win.document.referrer;
            }
          }
        });
      } else {
        resolve(this.win.document.referrer);
      }
    });

    /** @private {string} */
    this.resolvedViewerUrl_ = removeFragment(this.win.location.href || '');

    /** @const @private {!Promise<string>} */
    this.viewerUrl_ = new Promise(resolve => {
      /** @const {string} */
      const viewerUrlOverride = this.params_['viewerUrl'];
      if (this.isEmbedded() && viewerUrlOverride) {
        // Viewer override, but only for whitelisted viewers. Only allowed for
        // iframed documents.
        this.isTrustedViewer_.then(isTrusted => {
          if (isTrusted) {
            this.resolvedViewerUrl_ = viewerUrlOverride;
          } else {
            dev().error(TAG_, 'Untrusted viewer url override: ' +
                viewerUrlOverride + ' at ' +
                this.messagingOrigin_);
          }
          resolve(this.resolvedViewerUrl_);
        });
      } else {
        resolve(this.resolvedViewerUrl_);
      }
    });

    // Remove hash when we have an incoming click tracking string
    // (see impression.js).
    if (this.params_['click']) {
      const newUrl = removeFragment(this.win.location.href);
      if (newUrl != this.win.location.href && this.win.history.replaceState) {
        // Persist the hash that we removed has location.originalHash.
        // This is currently used my mode.js to infer development mode.
        if (!this.win.location.originalHash) {
          this.win.location.originalHash = this.win.location.hash;
        }
        this.win.history.replaceState({}, '', newUrl);
        dev().fine(TAG_, 'replace url:' + this.win.location.href);
      }
    }

    // Check if by the time the `Viewer`
    // instance is constructed, the document is already `visible`.
    this.recheckVisibilityState_();
    this.onVisibilityChange_();
  }

  /**
   * Handler for visibility change.
   * @private
   */
  onVisibilityChange_() {
    if (this.isVisible()) {
      if (!this.firstVisibleTime_) {
        this.firstVisibleTime_ = Date.now();
      }
      this.hasBeenVisible_ = true;
      this.whenFirstVisibleResolve_();
    }
    if (!this.visibilityObservable_) {
      this.visibilityObservable_ = new Observable();
    }
    this.visibilityObservable_.fire();
  }

  /**
   * Returns the value of a viewer's startup parameter with the specified
   * name or "undefined" if the parameter wasn't defined at startup time.
   * @param {string} name
   * @return {string|undefined}
   * @export
   */
  getParam(name) {
    return this.params_[name];
  }

  /**
   * Viewers can communicate their "capabilities" and this method allows
   * checking them.
   * @param {string} name Of the capability.
   * @return {boolean}
   */
  hasCapability(name) {
    const capabilities = this.params_['cap'];
    if (!capabilities) {
      return false;
    }
    // TODO(@cramforce): Consider caching the split.
    return capabilities.split(',').indexOf(name) != -1;
  }

  /**
   * Requests A2A navigation to the given destination. If the viewer does
   * not support this operation, will navigate the top level window
   * to the destination.
   * The URL is assumed to be in AMP Cache format already.
   * @param {string} url An AMP article URL.
   * @param {string} requestedBy Informational string about the entity that
   *     requested the navigation.
   */
  navigateTo(url, requestedBy) {
    dev().assert(isProxyOrigin(url), 'Invalid A2A URL %s %s', url, requestedBy);
    if (this.hasCapability('a2a')) {
      this.sendMessage('a2a', {
        url,
        requestedBy,
      });
    } else {
      this.win.top.location.href = url;
    }
  }

  /**
   * Whether the document is embedded in a iframe.
   * @return {boolean}
   */
  isIframed() {
    return this.isIframed_;
  }

  /**
   * Whether the document is embedded in a viewer.
   * @return {boolean}
   */
  isEmbedded() {
    return this.isEmbedded_;
  }

  /**
   * @return {boolean}
   */
  isRuntimeOn() {
    return this.isRuntimeOn_;
  }

  /**
   */
  toggleRuntime() {
    this.isRuntimeOn_ = !this.isRuntimeOn_;
    dev().fine(TAG_, 'Runtime state:', this.isRuntimeOn_);
    this.runtimeOnObservable_.fire(this.isRuntimeOn_);
  }

  /**
   * @param {function(boolean)} handler
   * @return {!UnlistenDef}
   */
  onRuntimeState(handler) {
    if (!this.runtimeOnObservable_) {
      this.runtimeOnObservable_ = new Observable();
    }
    return this.runtimeOnObservable_.add(handler);
  }

  /**
   * Whether the viewer overtakes the history for AMP document. If yes,
   * the viewer must implement history messages "pushHistory" and "popHistory"
   * and emit message "historyPopped"
   * @return {boolean}
   */
  isOvertakeHistory() {
    return this.overtakeHistory_;
  }

  /**
   * Returns visibility state configured by the viewer.
   * See {@link isVisible}.
   * @return {!VisibilityState}
   * TODO(dvoytenko, #5285): Move public API to AmpDoc.
   */
  getVisibilityState() {
    return this.visibilityState_;
  }

  /** @private */
  recheckVisibilityState_() {
    this.setVisibilityState_(this.viewerVisibilityState_);
  }

  /**
   * Sets the viewer defined visibility state.
   * @param {string|undefined} state
   * @private
   */
  setVisibilityState_(state) {
    if (!state) {
      return;
    }
    const oldState = this.visibilityState_;
    state = dev().assertEnumValue(VisibilityState, state, 'VisibilityState');

    // The viewer is informing us we are not currently active because we are
    // being pre-rendered, or the user swiped to another doc (or closed the
    // viewer). Unfortunately, the viewer sends HIDDEN instead of PRERENDER or
    // INACTIVE, though we know better.
    if (state === VisibilityState.HIDDEN) {
      state = this.hasBeenVisible_ ?
        VisibilityState.INACTIVE :
        VisibilityState.PRERENDER;
    }

    this.viewerVisibilityState_ = state;

    if (this.docState_.isHidden() &&
        (state === VisibilityState.VISIBLE ||
         state === VisibilityState.PAUSED)) {
      state = VisibilityState.HIDDEN;
    }

    this.visibilityState_ = state;

    dev().fine(TAG_, 'visibilitychange event:', this.getVisibilityState());

    if (oldState !== state) {
      this.onVisibilityChange_();
    }
  }

  /**
   * Whether the AMP document currently visible. The reasons why it might not
   * be visible include user switching to another tab, browser running the
   * document in the prerender mode or viewer running the document in the
   * prerender mode.
   * @return {boolean}
   */
  isVisible() {
    return this.getVisibilityState() == VisibilityState.VISIBLE;
  }

  /**
   * Whether the AMP document has been ever visible before. Since the visiblity
   * state of a document can be flipped back and forth we sometimes want to know
   * if a document has ever been visible.
   * @return {boolean}
   */
  hasBeenVisible() {
    return this.hasBeenVisible_;
  }

  /**
   * Returns a Promise that only ever resolved when the current
   * AMP document becomes visible.
   * @return {!Promise}
   */
  whenFirstVisible() {
    return this.whenFirstVisiblePromise_;
  }

  /**
   * Returns the time when the document has become visible for the first time.
   * If document has not yet become visible, the returned value is `null`.
   * @return {?time}
   */
  getFirstVisibleTime() {
    return this.firstVisibleTime_;
  }

  /**
   * How much the viewer has requested the runtime to prerender the document.
   * The values are in number of screens.
   * @return {number}
   */
  getPrerenderSize() {
    return this.prerenderSize_;
  }

  /**
   * Returns the top padding requested by the viewer.
   * @return {number}
   */
  getPaddingTop() {
    return this.paddingTop_;
  }

  /**
   * Returns the resolved viewer URL value. It's by default the current page's
   * URL. The trusted viewers are allowed to override this value.
   * @return {string}
   */
  getResolvedViewerUrl() {
    return this.resolvedViewerUrl_;
  }

  /**
   * Returns the promise that will yield the viewer URL value. It's by default
   * the current page's URL. The trusted viewers are allowed to override this
   * value.
   * @return {!Promise<string>}
   */
  getViewerUrl() {
    return this.viewerUrl_;
  }

  /**
   * Possibly return the messaging origin if set. This would be the origin
   * of the parent viewer.
   * @return {?string}
   */
  maybeGetMessagingOrigin() {
    return this.messagingOrigin_;
  }

  /**
   * Returns an unconfirmed "referrer" URL that can be optionally customized by
   * the viewer. Consider using `getReferrerUrl()` instead, which returns the
   * promise that will yield the confirmed "referrer" URL.
   * @return {string}
   */
  getUnconfirmedReferrerUrl() {
    return this.unconfirmedReferrerUrl_;
  }

  /**
   * Returns the promise that will yield the confirmed "referrer" URL. This
   * URL can be optionally customized by the viewer, but viewer is required
   * to be a trusted viewer.
   * @return {!Promise<string>}
   */
  getReferrerUrl() {
    return this.referrerUrl_;
  }

  /**
   * Whether the viewer has been whitelisted for more sensitive operations
   * such as customizing referrer.
   * @return {!Promise<boolean>}
   */
  isTrustedViewer() {
    return this.isTrustedViewer_;
  }

  /**
   * Returns the promise that resolves to URL representing the origin of the
   * viewer. If the document is not embedded or if a viewer origin can't be
   * found, empty string is returned.
   * @return {!Promise<string>}
   */
  getViewerOrigin() {
    return this.viewerOrigin_;
  }

  /**
   * @param {string} urlString
   * @return {boolean}
   * @private
   */
  isTrustedViewerOrigin_(urlString) {
    // TEMPORARY HACK due to a misbehaving native app. See b/32626673
    // In native apps all security bets are off anyway, and in browser
    // origins never take the form that is matched here.
    if (this.isWebviewEmbedded_ && /^www\.[.a-z]+$/.test(urlString)) {
      return TRUSTED_VIEWER_HOSTS.some(th => th.test(urlString));
    }
    /** @const {!Location} */
    const url = parseUrl(urlString);
    if (url.protocol != 'https:') {
      // Non-https origins are never trusted.
      return false;
    }
    return TRUSTED_VIEWER_HOSTS.some(th => th.test(url.hostname));
  }

  /**
   * Adds a "visibilitychange" event listener for viewer events. The
   * callback can check {@link isVisible} and {@link getPrefetchCount}
   * methods for more info.
   * @param {function()} handler
   * @return {!UnlistenDef}
   */
  onVisibilityChanged(handler) {
    if (!this.visibilityObservable_) {
      this.visibilityObservable_ = new Observable();
    }
    return this.visibilityObservable_.add(handler);
  }

  /**
   * Adds a "viewport" event listener for viewer events.
   * @param {function(!JSONType)} handler
   * @return {!UnlistenDef}
   */
  onViewportEvent(handler) {
    if (!this.viewportObservable_) {
      this.viewportObservable_ = new Observable();
    }
    return this.viewportObservable_.add(handler);
  }

  /**
   * Adds a "history popped" event listener for viewer events.
   * @param {function(ViewerHistoryPoppedEventDef)} handler
   * @return {!UnlistenDef}
   */
  onHistoryPoppedEvent(handler) {
    if (!this.historyPoppedObservable_) {
      this.historyPoppedObservable_ = new Observable();
    }
    return this.historyPoppedObservable_.add(handler);
  }

  /**
   * Triggers "documentLoaded" event for the viewer.
   * TODO: move this to resources-impl, and use sendMessage()
   */
  postDocumentReady() {
    this.sendMessage('documentLoaded', {
      title: this.win.document.title,
      sourceUrl: getSourceUrl(this.ampdoc.getUrl()),
    }, /* cancelUnsent */true);
  }

  /**
   * Triggers "pushHistory" event for the viewer.
   * @param {number} stackIndex
   * @return {!Promise}
   * TODO: move this to history-impl
   */
  postPushHistory(stackIndex) {
    return /** @type {!Promise} */ (this.sendMessageAwaitResponse(
        'pushHistory', {stackIndex}));
  }

  /**
   * Triggers "popHistory" event for the viewer.
   * @param {number} stackIndex
   * @return {!Promise}
   * TODO: move this to history-impl
   */
  postPopHistory(stackIndex) {
    return /** @type {!Promise} */ (this.sendMessageAwaitResponse(
        'popHistory', {stackIndex}));
  }

  /**
   * Get/set the Base CID from/to the viewer.
   * @param {string=} opt_data Stringified JSON object {cid, time}.
   * @return {!Promise<string|undefined>}
   * TODO: move this to cid-impl
   */
  baseCid(opt_data) {
    return this.isTrustedViewer().then(trusted => {
      if (!trusted) {
        return undefined;
      }
      const cidPromise = this.sendMessageAwaitResponse('cid', opt_data)
          .then(data => {
            // For backward compatibility: #4029
            if (data && !tryParseJson(data)) {
              return JSON.stringify({
                time: Date.now(), // CID returned from old API is always fresh
                cid: data,
              });
            }
            return data;
          });
      // Getting the CID may take some time (waits for JS file to
      // load, might hit GC), but we do not wait indefinitely. Typically
      // it should resolve in milli seconds.
      return timerFor(this.win).timeoutPromise(10000, cidPromise, 'base cid')
          .catch(error => {
            dev().error(TAG_, error);
            return undefined;
          });
    });
  }

  /**
   * Get the fragment from the url or the viewer.
   * Strip leading '#' in the fragment
   * @return {!Promise<string>}
   * TODO: move this to history-impl
   */
  getFragment() {
    if (!this.isEmbedded_) {
      let hash = this.win.location.hash;
      /* Strip leading '#' */
      hash = hash.substr(1);
      return Promise.resolve(hash);
    }
    if (!this.hasCapability('fragment')) {
      return Promise.resolve('');
    }
    return this.sendMessageAwaitResponse('fragment', undefined,
        /* cancelUnsent */true).then(
        hash => {
          if (!hash) {
            return '';
          }
          dev().assert(hash[0] == '#', 'Url fragment received from viewer ' +
              'should start with #');
          /* Strip leading '#' */
          return hash.substr(1);
        });
  }

  /**
   * Update the fragment of the viewer if embedded in a viewer,
   * otherwise update the page url fragment
   * The fragment variable should contain leading '#'
   * @param {string} fragment
   * @return {!Promise}
   * TODO: move this to history-impl
   */
  updateFragment(fragment) {
    dev().assert(fragment[0] == '#', 'Fragment to be updated ' +
        'should start with #');
    if (!this.isEmbedded_) {
      if (this.win.history.replaceState) {
        this.win.history.replaceState({}, '', fragment);
      }
      return Promise.resolve();
    }
    if (!this.hasCapability('fragment')) {
      return Promise.resolve();
    }
    return /** @type {!Promise} */ (this.sendMessageAwaitResponse(
        'fragment', {fragment}, /* cancelUnsent */true));
  }

  /**
   * Requests AMP document to receive a message from Viewer.
   * @param {string} eventType
   * @param {!JSONType} data
   * @param {boolean} unusedAwaitResponse
   * @return {(!Promise<*>|undefined)}
   * @export
   */
  receiveMessage(eventType, data, unusedAwaitResponse) {
    if (eventType == 'viewport') {
      if (data['paddingTop'] !== undefined) {
        this.paddingTop_ = data['paddingTop'];
        this.viewportObservable_.fire(
          /** @type {!JSONType} */ (data));
        return Promise.resolve();
      }
      return undefined;
    }
    if (eventType == 'historyPopped') {
      this.historyPoppedObservable_.fire({
        newStackIndex: data['newStackIndex'],
      });
      return Promise.resolve();
    }
    if (eventType == 'visibilitychange') {
      if (data['prerenderSize'] !== undefined) {
        this.prerenderSize_ = data['prerenderSize'];
        dev().fine(TAG_, '- prerenderSize change:', this.prerenderSize_);
      }
      this.setVisibilityState_(data['state']);
      return Promise.resolve();
    }
    if (eventType == 'broadcast') {
      this.broadcastObservable_.fire(
          /** @type {!JSONType|undefined} */ (data));
      return Promise.resolve();
    }
    dev().fine(TAG_, 'unknown message:', eventType);
    return undefined;
  }

  /**
   * Provides a message delivery mechanism by which AMP document can send
   * messages to the viewer.
   * @param {function(string, *, boolean):(!Promise<*>|undefined)} deliverer
   * @param {string} origin
   * @export
   */
  setMessageDeliverer(deliverer, origin) {
    if (this.messageDeliverer_) {
      throw new Error('message channel can only be initialized once');
    }
    if (!origin) {
      throw new Error('message channel must have an origin');
    }
    dev().fine(TAG_, 'message channel established with origin: ', origin);
    this.messageDeliverer_ = deliverer;
    this.messagingOrigin_ = origin;
    if (this.messagingReadyResolver_) {
      this.messagingReadyResolver_();
    }
    if (this.trustedViewerResolver_) {
      this.trustedViewerResolver_(
          origin ? this.isTrustedViewerOrigin_(origin) : false);
    }
    if (this.viewerOriginResolver_) {
      this.viewerOriginResolver_(origin || '');
    }

    if (this.messageQueue_.length > 0) {
      const queue = this.messageQueue_.slice(0);
      this.messageQueue_ = [];
      queue.forEach(message => {
        const responsePromise = this.messageDeliverer_(
            message.eventType, message.data, message.awaitResponse);

        if (message.awaitResponse) {
          message.responseResolver(responsePromise);
        }
      });
    }
  }

  /**
   * Sends the message to the viewer without waiting for any response.
   * If cancelUnsent is true, the previous message of the same message type will
   * be canceled.
   *
   * This is a restricted API.
   *
   * @param {string} eventType
   * @param {*} data
   * @param {boolean=} cancelUnsent
   */
  sendMessage(eventType, data, cancelUnsent = false) {
    this.sendMessageInternal_(eventType, data, cancelUnsent, false);
  }

  /**
   * Sends the message to the viewer and wait for response.
   * If cancelUnsent is true, the previous message of the same message type will
   * be canceled.
   *
   * This is a restricted API.
   *
   * @param {string} eventType
   * @param {*} data
   * @param {boolean=} cancelUnsent
   * @return {!Promise<*>} the response promise
   */
  sendMessageAwaitResponse(eventType, data, cancelUnsent = false) {
    return this.sendMessageInternal_(eventType, data, cancelUnsent, true);
  }

  /**
   * Sends the message to the viewer.
   *
   * @param {string} eventType
   * @param {*} data
   * @param {boolean} cancelUnsent
   * @param {boolean} awaitResponse
   * @return {!Promise<*>} the response promise
   */
  sendMessageInternal_(eventType, data, cancelUnsent, awaitResponse) {
    if (this.messageDeliverer_) {
      return /** @type {!Promise<*>} */ (this.messageDeliverer_(
          eventType, data, awaitResponse));
    }

    if (!this.messagingReadyPromise_) {
      if (awaitResponse) {
        return Promise.reject(getChannelError());
      } else {
        return Promise.resolve();
      }
    }

    if (!cancelUnsent) {
      return this.messagingReadyPromise_.then(() => {
        return this.messageDeliverer_(eventType, data, awaitResponse);
      });
    }

    const found = findIndex(this.messageQueue_,
        m => m.eventType == eventType);

    let message;
    if (found != -1) {
      message = this.messageQueue_.splice(found, 1)[0];
      message.data = data;
      message.awaitResponse = message.awaitResponse || awaitResponse;
    } else {
      let responseResolver;
      const responsePromise = new Promise(r => {
        responseResolver = r;
      });
      message = {
        eventType,
        data,
        awaitResponse,
        responsePromise,
        responseResolver,
      };
    }
    this.messageQueue_.push(message);
    return message.responsePromise;
  }

  /**
   * Broadcasts a message to all other AMP documents under the same viewer. It
   * will attempt to deliver messages when the messaging channel has been
   * established, but it will not fail if the channel is timed out.
   *
   * @param {!JSONType} message
   */
  broadcast(message) {
    if (!this.messagingMaybePromise_) {
      // Messaging is not expected.
      return;
    }

    this.sendMessage('broadcast', message);
  }

  /**
   * Registers receiver for the broadcast events.
   * @param {function(!JSONType)} handler
   * @return {!UnlistenDef}
   */
  onBroadcast(handler) {
    if (!this.broadcastObservable_) {
      this.broadcastObservable_ = new Observable();
    }
    return this.broadcastObservable_.add(handler);
  }

  /**
   * Resolves when there is a messaging channel established with the viewer.
   * Will be null if no messaging is needed like in an non-embedded document.
   * @return {?Promise}
   */
  whenMessagingReady() {
    return this.messagingMaybePromise_;
  }
}


/**
 * Parses the viewer parameters as a string.
 *
 * Visible for testing only.
 *
 * @param {string} str
 * @param {!Object<string, string>} allParams
 * @private
 */
function parseParams_(str, allParams) {
  const params = parseQueryString(str);
  for (const k in params) {
    allParams[k] = params[k];
  }
}


/**
 * Creates an error for the case where a channel cannot be established.
 * @param {*=} opt_reason
 * @return {!Error}
 */
function getChannelError(opt_reason) {
  if (opt_reason instanceof Error) {
    opt_reason.message = 'No messaging channel: ' + opt_reason.message;
    return opt_reason;
  }
  return new Error('No messaging channel: ' + opt_reason);
}

/**
 * @typedef {{
 *   newStackIndex: number
 * }}
 */
export let ViewerHistoryPoppedEventDef;


/**
 * Sets the viewer visibility state. This calls is restricted to runtime only.
 * @param {!VisibilityState} state
 * @restricted
 */
export function setViewerVisibilityState(viewer, state) {
  viewer.setVisibilityState_(state);
}


/**
 * @param {!./ampdoc-impl.AmpDoc} ampdoc
 * @param {!Object<string, string>=} opt_initParams
 * @return {!Viewer}
 */
export function installViewerServiceForDoc(ampdoc, opt_initParams) {
  return getServiceForDoc(ampdoc, 'viewer',
      () => new Viewer(ampdoc, opt_initParams));
}
