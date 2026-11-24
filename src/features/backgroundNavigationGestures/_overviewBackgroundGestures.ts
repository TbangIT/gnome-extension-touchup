import {GestureRecognizer} from "$src/utils/gestures/gestureRecognizer";
import * as Main from "resource:///org/gnome/shell/ui/main.js";
import Clutter from "gi://Clutter";
import {PatchManager} from "$src/core/patchManager";
import ExtensionFeature from "$src/core/extensionFeature";
import {SmoothNavigationGestureController} from "$src/utils/gestures/smoothNavigationGestureController";
import {settings} from "$src/settings";


function _getThumbnailsBoxes(): Clutter.Actor[] {
    const boxes: Clutter.Actor[] = [];
    const controls = (Main.overview as any)?._overview?._controls ?? (Main.overview as any)?._overview?.controls;
    if (controls) {
        if (controls._thumbnailsBox)
            boxes.push(controls._thumbnailsBox);
        if (controls._secondaryThumbnailsBox)
            boxes.push(controls._secondaryThumbnailsBox);
        const views = controls._workspacesDisplay?._workspacesViews;
        if (Array.isArray(views)) {
            for (const v of views) {
                if (v._thumbnails && !boxes.includes(v._thumbnails))
                    boxes.push(v._thumbnails);
                if (v._thumbnailsBox && !boxes.includes(v._thumbnailsBox))
                    boxes.push(v._thumbnailsBox);
            }
        }
    }
    return boxes;
}

function _isInsideActor(actor: any, x: number, y: number): boolean {
    if (!actor || !actor.is_mapped?.() || !actor.visible || actor.opacity === 0)
        return false;
    try {
        const [success, localX, localY] = actor.transform_stage_point(x, y);
        if (success && localX >= 0 && localX <= actor.width && localY >= 0 && localY <= actor.height)
            return true;
    } catch (_) {}
    try {
        const [gx, gy] = actor.get_transformed_position();
        const [gw, gh] = actor.get_transformed_size();
        if (x >= gx && x <= gx + gw && y >= gy && y <= gy + gh)
            return true;
    } catch (_) {}
    return false;
}

function _isInsideThumbnailsArea(x: number, y: number, sourceActor?: Clutter.Actor | null): boolean {
    const boxes = _getThumbnailsBoxes();
    for (const box of boxes) {
        if (!box) continue;
        if (sourceActor && (box === sourceActor || (box.contains && box.contains(sourceActor))))
            return true;
        if (!isNaN(x) && !isNaN(y)) {
            if (_isInsideActor(box, x, y))
                return true;
            if (Array.isArray((box as any)._thumbnails)) {
                for (const thumb of (box as any)._thumbnails) {
                    if (thumb && _isInsideActor(thumb, x, y))
                        return true;
                }
            }
        }
    }
    return false;
}

export class OverviewBackgroundGesturesFeature extends ExtensionFeature {
    static readonly clutterGestureName = "touchup-overview-background-gesture";

    private readonly gesture: Clutter.PanGesture;
    private _navigationGestureController: SmoothNavigationGestureController;


    constructor(pm: PatchManager) {
        super(pm);

        this._navigationGestureController = new SmoothNavigationGestureController();
        let gestureInhibited = false;

        const recognizer = new GestureRecognizer({
            onGestureStarted: _ => {
                if (recognizer.currentState.events[0]?.isPointerEvent)
                    return;

                if (settings.backgroundNavigationGestures.thumbnailsProtectionEnabled.get()) {
                    const firstEvent = recognizer.currentState.events[0];
                    if (firstEvent && _isInsideThumbnailsArea(firstEvent.x, firstEvent.y, null)) {
                        gestureInhibited = true;
                        return;
                    }
                }

                gestureInhibited = false;
                this._navigationGestureController.gestureBegin();
            },
            onGestureProgress: state => {
                if (gestureInhibited || state.events[0]?.isPointerEvent)
                    return;

                const d = state.totalMotionDelta;
                const axisLock = settings.backgroundNavigationGestures.axisLockEnabled.get();

                if (axisLock) {
                    const axis = state.firstMotionDirection?.axis;
                    if (axis === 'horizontal') {
                        this._navigationGestureController.gestureProgress(
                            0,
                            -d.x / (this._navigationGestureController.workspaceBaseDist * 0.62)
                        );
                    } else {
                        this._navigationGestureController.gestureProgress(
                            -d.y / (this._navigationGestureController.overviewBaseDist * 0.25),
                            0
                        );
                    }
                } else {
                    this._navigationGestureController.gestureProgress(
                        -d.y / (this._navigationGestureController.overviewBaseDist * 0.25),
                        -d.x / (this._navigationGestureController.workspaceBaseDist * 0.62)
                    );
                }
            },
            onGestureCompleted: state => {
                if (gestureInhibited) {
                    gestureInhibited = false;
                    return;
                }

                if (state.events[0]?.isPointerEvent) {
                    this._navigationGestureController.gestureCancel();
                    return;
                }

                const axisLock = settings.backgroundNavigationGestures.axisLockEnabled.get();
                if (axisLock) {
                    const axis = state.firstMotionDirection?.axis;
                    const d = state.totalMotionDelta;
                    const dir = state.finalMotionDirection?.direction ?? state.lastMotionDirection?.direction ?? state.firstMotionDirection?.direction ?? null;

                    if (axis === 'horizontal') {
                        let hDir: 'left' | 'right' | null = dir === 'left' || dir === 'right' ? dir : null;
                        if (!hDir) {
                            if (d.x < -25) hDir = 'left';
                            else if (d.x > 25) hDir = 'right';
                        }
                        this._navigationGestureController.gestureEnd(hDir);
                    } else {
                        let vDir: 'up' | 'down' | null = dir === 'up' || dir === 'down' ? dir : null;
                        if (!vDir) {
                            if (d.y < -25) vDir = 'up';
                            else if (d.y > 25) vDir = 'down';
                        }
                        this._navigationGestureController.gestureEnd(vDir);
                    }
                } else {
                    this._navigationGestureController.gestureEnd(state.finalMotionDirection?.direction);
                }
            },
            onGestureCanceled: _ => {
                if (gestureInhibited) {
                    gestureInhibited = false;
                    return;
                }
                this._navigationGestureController.gestureCancel();
            },
        });

        this.gesture = recognizer.createPanGesture();

        this.pm.connectTo(this.gesture, 'may-recognize', () => {
            if (!settings.backgroundNavigationGestures.thumbnailsProtectionEnabled.get())
                return true;

            let x = NaN, y = NaN, source: Clutter.Actor | null = null;
            const event = (this.gesture as any).get_point_event?.(0) ?? Clutter.get_current_event();
            if (event) {
                try {
                    const coords = event.get_coords();
                    x = coords[0];
                    y = coords[1];
                } catch (_) {}
                try {
                    source = event.get_source() as Clutter.Actor;
                } catch (_) {}
            }
            if (isNaN(x) || isNaN(y)) {
                try {
                    const pt = (this.gesture as any).get_point_begin_coords?.(0) ?? (this.gesture as any).get_point_coords?.(0);
                    if (pt) {
                        x = pt.x;
                        y = pt.y;
                    }
                } catch (_) {}
            }
            if (_isInsideThumbnailsArea(x, y, source)) {
                return false;
            }
            return true;
        });

        this.pm.patch(() => {
            Main.overview._overview._controls.add_action_full(
                OverviewBackgroundGesturesFeature.clutterGestureName,
                Clutter.EventPhase.BUBBLE,
                this.gesture,
            );
            return () => Main.overview._overview._controls.remove_action(this.gesture);
        });
        this.pm.setProperty(Main.overview._overview._controls, 'reactive', true);
    }
    
    canNotCancel(otherGesture: Clutter.PanGesture) {
        this.gesture.can_not_cancel(otherGesture);
    }

    destroy() {
        this._navigationGestureController.destroy();
        super.destroy();
    }
}
