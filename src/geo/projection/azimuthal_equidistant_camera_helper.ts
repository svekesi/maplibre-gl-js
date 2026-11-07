import {LngLat, type LngLatLike} from '../lng_lat.ts';
import {MercatorCameraHelper} from './mercator_camera_helper.ts';
import {differenceOfAnglesDegrees, scaleZoom, zoomScale} from '../../util/util.ts';
import {interpolates} from '@maplibre/maplibre-gl-style-spec';
import {azimuthalPlaneToLngLat, lngLatToAzimuthalPlane} from './azimuthal_equidistant_utils.ts';

import type Point from '@mapbox/point-geometry';
import type {CameraForBoxAndBearingHandlerResult, EaseToHandlerResult, EaseToHandlerOptions, FlyToHandlerResult, FlyToHandlerOptions, ICameraHelper, MapControlsDeltas} from './camera_helper.ts';
import type {IReadonlyTransform, ITransform} from '../transform_interface.ts';
import type {AzimuthalEquidistantProjection} from './azimuthal_equidistant_projection.ts';
import type {CameraForBoundsOptions} from '../../ui/camera.ts';
import type {LngLatBounds} from '../lng_lat_bounds.ts';
import type {PaddingOptions} from '../edge_insets.ts';

/**
 * Rotation of the azimuthal plane on screen, in degrees: the plane is rotated by the center longitude and by the bearing.
 * Panning keeps this value, flights interpolate it.
 */
function planeRotation(center: LngLat, bearing: number): number {
    return center.lng - bearing;
}

/**
 * @internal
 * Camera helper for the azimuthal equidistant projection.
 *
 * Gestures work like in mercator: all of them end in `setLocationAtPoint`, which moves the disk without rotating it
 * in the azimuthal view (see the plane transform). `easeTo` and `flyTo` with a target center move the center along
 * a straight line in the azimuthal plane and interpolate the rotation of the plane, so that the requested bearing is
 * reached exactly, also when the flight passes the transition to mercator.
 */
export class AzimuthalEquidistantCameraHelper implements ICameraHelper {
    private _projection: AzimuthalEquidistantProjection;
    private _mercatorCameraHelper: MercatorCameraHelper;

    constructor(projection: AzimuthalEquidistantProjection) {
        this._projection = projection;
        this._mercatorCameraHelper = new MercatorCameraHelper();
    }

    get useGlobeControls(): boolean { return false; }

    handlePanInertia(pan: Point, transform: IReadonlyTransform): {
        easingCenter: LngLat;
        easingOffset: Point;
    } {
        return this._mercatorCameraHelper.handlePanInertia(pan, transform);
    }

    handleMapControlsRollPitchBearingZoom(deltas: MapControlsDeltas, tr: ITransform): void {
        if (deltas.bearingDelta) tr.setBearing(tr.bearing + deltas.bearingDelta);
        // The pure azimuthal view is never pitched, see the plane transform. Do not accumulate an invisible pitch.
        if (deltas.pitchDelta && this._projection.transitionState < 1) tr.setPitch(tr.pitch + deltas.pitchDelta);
        if (deltas.rollDelta) tr.setRoll(tr.roll + deltas.rollDelta);
        if (deltas.zoomDelta) tr.setZoom(tr.zoom + deltas.zoomDelta);
    }

    handleMapControlsPan(deltas: MapControlsDeltas, tr: ITransform, preZoomAroundLoc: LngLat): void {
        this._mercatorCameraHelper.handleMapControlsPan(deltas, tr, preZoomAroundLoc);
    }

    cameraForBoxAndBearing(options: CameraForBoundsOptions, fitPadding: PaddingOptions, mapPadding: PaddingOptions, bounds: LngLatBounds, bearing: number, tr: IReadonlyTransform): CameraForBoxAndBearingHandlerResult {
        // Small boxes are shown in mercator anyway, for large boxes the mercator result is a usable approximation.
        return this._mercatorCameraHelper.cameraForBoxAndBearing(options, fitPadding, mapPadding, bounds, bearing, tr);
    }

    handleJumpToCenterZoom(tr: ITransform, options: { zoom?: number; center?: LngLatLike }): void {
        this._mercatorCameraHelper.handleJumpToCenterZoom(tr, options);
    }

    handleEaseTo(tr: ITransform, options: EaseToHandlerOptions): EaseToHandlerResult {
        const startZoom = tr.zoom;
        const endZoomRequested = options.zoom !== undefined ? +options.zoom : startZoom;
        const staysInMercator = this._projection.getTransitionStateAtZoom(startZoom) === 0 &&
            this._projection.getTransitionStateAtZoom(endZoomRequested) === 0;
        const hasOffset = options.offsetAsPoint && (options.offsetAsPoint.x !== 0 || options.offsetAsPoint.y !== 0);
        // Zooming around a point and panning by an offset are gestures: they must not rotate the disk.
        if (options.around || hasOffset || staysInMercator) {
            return this._mercatorCameraHelper.handleEaseTo(tr, options);
        }

        const startPadding = tr.padding;
        const doPadding = !tr.isPaddingEqual(options.padding);
        const startCenter = tr.center;
        const startPitch = tr.pitch;
        const startRoll = tr.roll;
        const endPitch = options.pitch === undefined ? startPitch : options.pitch;
        const endRoll = options.roll === undefined ? startRoll : options.roll;
        const endBearing = options.bearing === undefined ? tr.bearing : options.bearing;

        const {center: endCenter, zoom: endZoom} = tr.applyConstrain(
            LngLat.convert(options.center || startCenter),
            endZoomRequested
        );
        const from = lngLatToAzimuthalPlane(startCenter.lng, startCenter.lat);
        const to = lngLatToAzimuthalPlane(endCenter.lng, endCenter.lat);
        const startRotation = planeRotation(startCenter, tr.bearing);
        const rotationDelta = differenceOfAnglesDegrees(startRotation, planeRotation(endCenter, endBearing));
        const isZooming = endZoom !== startZoom;

        const easeFunc = (k: number) => {
            if (isZooming) {
                tr.setZoom(interpolates.number(startZoom, endZoom, k));
            }
            if (startPitch !== endPitch) {
                tr.setPitch(interpolates.number(startPitch, endPitch, k));
            }
            if (startRoll !== endRoll) {
                tr.setRoll(interpolates.number(startRoll, endRoll, k));
            }
            if (doPadding) {
                tr.interpolatePadding(startPadding, options.padding, k);
            }
            if (k === 1) {
                tr.setCenter(endCenter);
                tr.setBearing(endBearing);
                return;
            }
            const center = azimuthalPlaneToLngLat(
                interpolates.number(from[0], to[0], k),
                interpolates.number(from[1], to[1], k),
                tr.center.lng
            );
            tr.setCenter(center);
            tr.setBearing(center.lng - (startRotation + rotationDelta * k));
        };

        return {
            easeFunc,
            isZooming,
            elevationCenter: endCenter,
        };
    }

    handleFlyTo(tr: ITransform, options: FlyToHandlerOptions): FlyToHandlerResult {
        const startZoom = tr.zoom;
        const startCenter = tr.center;
        const optionsZoom = typeof options.zoom !== 'undefined';

        const constrained = tr.applyConstrain(
            LngLat.convert(options.center || options.locationAtOffset),
            optionsZoom ? +options.zoom : startZoom
        );
        const targetCenter = constrained.center;
        const targetZoom = constrained.zoom;

        const from = lngLatToAzimuthalPlane(startCenter.lng, startCenter.lat);
        const to = lngLatToAzimuthalPlane(targetCenter.lng, targetCenter.lat);
        const startRotation = planeRotation(startCenter, tr.bearing);
        const rotationDelta = differenceOfAnglesDegrees(startRotation, planeRotation(targetCenter, options.bearing));

        // Path length in pixels at the start zoom, measured at the scale of the azimuthal plane.
        const pixelPathLength = Math.hypot(to[0] - from[0], to[1] - from[1]) * tr.worldSize / (2 * Math.PI);
        const scaleOfZoom = zoomScale(targetZoom - startZoom);

        // The camera always limits the flight curve by this zoom, like in the mercator camera helper.
        const requestedMinZoom = typeof options.minZoom !== 'undefined' ? +options.minZoom : tr.minZoom;
        const minZoomPreConstrain = Math.min(Math.max(requestedMinZoom, tr.minZoom), startZoom, targetZoom);
        const minZoom = tr.applyConstrain(targetCenter, minZoomPreConstrain).zoom;
        const scaleOfMinZoom = zoomScale(minZoom - startZoom);

        const easeFunc = (k: number, scale: number, centerFactor: number, _pointAtOffset: Point) => {
            tr.setZoom(k === 1 ? targetZoom : startZoom + scaleZoom(scale));
            if (k === 1) {
                tr.setCenter(targetCenter);
                tr.setBearing(options.bearing);
                return;
            }
            const center = azimuthalPlaneToLngLat(
                from[0] + (to[0] - from[0]) * centerFactor,
                from[1] + (to[1] - from[1]) * centerFactor,
                tr.center.lng
            );
            tr.setCenter(center);
            tr.setBearing(center.lng - (startRotation + rotationDelta * k));
        };

        return {
            easeFunc,
            scaleOfZoom,
            targetCenter,
            scaleOfMinZoom,
            pixelPathLength,
        };
    }
}
