import {mat4, vec3, vec4, type mat2} from 'gl-matrix';
import Point from '@mapbox/point-geometry';
import {TransformHelper} from '../transform_helper.ts';
import {LngLat, type LngLatLike, earthRadius} from '../lng_lat.ts';
import {MercatorCoordinate} from '../mercator_coordinate.ts';
import {LngLatBounds} from '../lng_lat_bounds.ts';
import {OverscaledTileID, UnwrappedTileID, type CanonicalTileID} from '../../tile/tile_id.ts';
import {clamp, createIdentityMat4f32, createIdentityMat4f64, createMat4f64, createVec3f64, degreesToRadians, differenceOfAnglesDegrees, MAX_VALID_LATITUDE, scaleZoom, warnOnce, wrap, type Mat4f32} from '../../util/util.ts';
import {Frustum} from '../../util/primitives/frustum.ts';
import {getCenterOffset, getWorldSize} from '../camera_state.ts';
import {
    AZIMUTHAL_SOUTHERN_LIMIT_DEGREES,
    azimuthalLocalFrame,
    azimuthalPlaneToLngLat,
    azimuthalScaleRatio,
    getAzimuthalOuterRingColatitude,
    lngLatToAzimuthalPlane,
    mercatorYToColatitude,
    projectTileCoordinatesToAzimuthalPlane
} from './azimuthal_equidistant_utils.ts';
import {AzimuthalEquidistantCoveringTilesDetailsProvider} from './azimuthal_equidistant_covering_tiles_details_provider.ts';
import {getMercatorTileCoordinates, tileCoordinatesToMercatorCoordinates} from './mercator_utils.ts';
import {Bounds} from '../bounds.ts';

import type {CameraState} from '../camera_state.ts';
import type {Terrain} from '../../render/terrain.ts';
import type {PointProjection} from '../../symbol/projection.ts';
import type {CameraOptionsFromTo, IReadonlyTransform, ITransform, NearFarZ, TransformConstrainFunction, WorldCoordinateHelper} from '../transform_interface.ts';
import type {TransformOptions} from '../transform_helper.ts';
import type {PaddingOptions} from '../edge_insets.ts';
import type {CustomLayerProjectionData, ProjectionDataParams, RendererProjectionData} from './projection_data.ts';
import type {CoveringTilesDetailsProvider} from './covering_tiles_details_provider.ts';

/**
 * Transform for the azimuthal equidistant projection centered on the north pole.
 *
 * The map is a flat disk, so the camera works like the mercator camera: the plane is scaled to pixels and rotated by the bearing,
 * and pitch tilts the plane. The plane is additionally rotated by the longitude of the map center, so that the meridian
 * through the center points straight up when the bearing is 0, and `bearing` keeps its usual meaning (direction of north at the center).
 *
 * Panning moves the disk without rotating it. Because north points towards the pole, the bearing changes while panning
 * by the change of the center longitude. See {@link setLocationAtPoint}.
 *
 * The scale of the plane is `worldSize / 2π` pixels per earth radius, which equals the mercator scale at the equator.
 * During a transition to mercator (`azimuthalness` below 1) the scale grows towards the mercator scale at the center latitude,
 * and the stretch of the parallels at the center is compensated, so that both projections coincide at the map center
 * when the transition ends.
 *
 * Pitch is suppressed in the pure azimuthal view and only fades in during the transition to mercator.
 */
export class AzimuthalEquidistantPlaneTransform implements ITransform {
    private _helper: TransformHelper;

    //
    // Implementation of transform getters and setters
    //

    get pixelsToClipSpaceMatrix(): mat4 {
        return this._helper.pixelsToClipSpaceMatrix;
    }
    get clipSpaceToPixelsMatrix(): mat4 {
        return this._helper.clipSpaceToPixelsMatrix;
    }
    get pixelsToGLUnits(): [number, number] {
        return this._helper.pixelsToGLUnits;
    }
    get size(): Point {
        return this._helper.size;
    }
    get rotationMatrix(): mat2 {
        return this._helper.rotationMatrix;
    }
    get centerPoint(): Point {
        return this._helper.centerPoint;
    }
    get pixelsPerMeter(): number {
        // The plane has its own scale, see planeRadiusPixels.
        return this.planeRadiusPixels / earthRadius;
    }
    setMinZoom(zoom: number): void {
        this._helper.setMinZoom(zoom);
    }
    setMaxZoom(zoom: number): void {
        this._helper.setMaxZoom(zoom);
    }
    setMinPitch(pitch: number): void {
        this._helper.setMinPitch(pitch);
    }
    setMaxPitch(pitch: number): void {
        this._helper.setMaxPitch(pitch);
    }
    setRenderWorldCopies(renderWorldCopies: boolean): void {
        this._helper.setRenderWorldCopies(renderWorldCopies);
    }
    setBearing(bearing: number): void {
        this._helper.setBearing(bearing);
    }
    setPitch(pitch: number): void {
        this._helper.setPitch(pitch);
    }
    setRoll(roll: number): void {
        this._helper.setRoll(roll);
    }
    setFov(fov: number): void {
        this._helper.setFov(fov);
    }
    setZoom(zoom: number): void {
        this._helper.setZoom(zoom);
    }
    setCenter(center: LngLat): void {
        this._helper.setCenter(center);
    }
    setElevation(elevation: number): void {
        this._helper.setElevation(elevation);
    }
    setMinElevationForCurrentTile(elevation: number): void {
        this._helper.setMinElevationForCurrentTile(elevation);
    }
    setPadding(padding: PaddingOptions): void {
        this._helper.setPadding(padding);
    }
    interpolatePadding(start: PaddingOptions, target: PaddingOptions, t: number): void {
        this._helper.interpolatePadding(start, target, t);
    }
    isPaddingEqual(padding: PaddingOptions): boolean {
        return this._helper.isPaddingEqual(padding);
    }
    resize(width: number, height: number, constrain: boolean = true): void {
        this._helper.resize(width, height, constrain);
    }
    getMaxBounds(): LngLatBounds {
        return this._helper.getMaxBounds();
    }
    setMaxBounds(bounds?: LngLatBounds): void {
        this._helper.setMaxBounds(bounds);
    }
    setConstrainOverride(constrain?: TransformConstrainFunction | null): void {
        this._helper.setConstrainOverride(constrain);
    }
    overrideNearFarZ(nearZ: number, farZ: number): void {
        this._helper.overrideNearFarZ(nearZ, farZ);
    }
    clearNearFarZOverride(): void {
        this._helper.clearNearFarZOverride();
    }
    getCameraQueryGeometry(queryGeometry: Point[]): Point[] {
        // Like the helper, but from the camera point of the azimuthal view, which follows the suppressed pitch.
        const cameraPoint = this.getCameraPoint();
        if (queryGeometry.length === 1) {
            return [queryGeometry[0], cameraPoint];
        }
        const {minX, minY, maxX, maxY} = Bounds.fromPoints(queryGeometry).extend(cameraPoint);
        return [
            new Point(minX, minY),
            new Point(maxX, minY),
            new Point(maxX, maxY),
            new Point(minX, maxY),
            new Point(minX, minY)
        ];
    }

    get tileSize(): number {
        return this._helper.tileSize;
    }
    get tileZoom(): number {
        return this._helper.tileZoom;
    }
    get scale(): number {
        return this._helper.scale;
    }
    get worldSize(): number {
        return this._helper.worldSize;
    }
    get width(): number {
        return this._helper.width;
    }
    get height(): number {
        return this._helper.height;
    }
    get lngRange(): [number, number] {
        return this._helper.lngRange;
    }
    get latRange(): [number, number] {
        return this._helper.latRange;
    }
    get minZoom(): number {
        return this._helper.minZoom;
    }
    get maxZoom(): number {
        return this._helper.maxZoom;
    }
    get zoom(): number {
        return this._helper.zoom;
    }
    get center(): LngLat {
        return this._helper.center;
    }
    get minPitch(): number {
        return this._helper.minPitch;
    }
    get maxPitch(): number {
        return this._helper.maxPitch;
    }
    get pitch(): number {
        return this._helper.pitch;
    }
    get pitchInRadians(): number {
        return this._helper.pitchInRadians;
    }
    get roll(): number {
        return this._helper.roll;
    }
    get rollInRadians(): number {
        return this._helper.rollInRadians;
    }
    get bearing(): number {
        return this._helper.bearing;
    }
    get bearingInRadians(): number {
        return this._helper.bearingInRadians;
    }
    get fov(): number {
        return this._helper.fov;
    }
    get fovInRadians(): number {
        return this._helper.fovInRadians;
    }
    get elevation(): number {
        return this._helper.elevation;
    }
    get minElevationForCurrentTile(): number {
        return this._helper.minElevationForCurrentTile;
    }
    get padding(): PaddingOptions {
        return this._helper.padding;
    }
    get unmodified(): boolean {
        return this._helper.unmodified;
    }
    get renderWorldCopies(): boolean {
        return this._helper.renderWorldCopies;
    }
    get constrainOverride(): TransformConstrainFunction {
        return this._helper.constrainOverride;
    }
    public get nearZ(): number {
        return this._nearZ;
    }
    public get farZ(): number {
        return this._farZ;
    }
    public get nearFarZOverride(): NearFarZ | null {
        return this._helper.nearFarZOverride;
    }
    public get autoCalculateNearFarZ(): boolean {
        return this._helper.autoCalculateNearFarZ;
    }

    setTransitionState(_value: number): void {
        // Do nothing, the composing transform supplies the azimuthalness with setAzimuthalness.
    }

    //
    // Implementation of the azimuthal transform
    //

    /**
     * 1 for the pure azimuthal projection, less than 1 during the transition to mercator.
     */
    private _azimuthalness: number = 1;
    private _projectionMatrix: mat4 = createIdentityMat4f64();
    private _invProjMatrix: mat4 = createIdentityMat4f64();
    private _viewProjMatrix: mat4 = createIdentityMat4f64();
    private _viewProjMatrix32f: Mat4f32 = createIdentityMat4f32(); // Must be 32 bit floats, otherwise WebGL calls in Chrome get very slow.
    private _invViewProjMatrix: mat4 = createIdentityMat4f64();
    private _pixelMatrix: mat4 = createIdentityMat4f64();
    private _pixelMatrixInverse: mat4 = createIdentityMat4f64();
    private _cameraPosition: vec3 = createVec3f64();
    private _nearZ: number;
    private _farZ: number;
    private _cachedFrustum: Frustum;
    private _coveringTilesDetailsProvider: AzimuthalEquidistantCoveringTilesDetailsProvider;

    /**
     * @param options - Initial state. Ignored when `sharedHelper` is given, which already carries it.
     * @param sharedHelper - Camera to use instead of owning one, so that the composing {@link AzimuthalEquidistantTransform}
     * keeps a single copy of the state. Its owner then drives {@link _calcMatrices}.
     */
    public constructor(options?: TransformOptions, sharedHelper?: TransformHelper) {
        this._helper = sharedHelper ?? new TransformHelper({
            calcMatrices: () => this._calcMatrices(),
            defaultConstrain: (center, zoom) => { return this.defaultConstrain(center, zoom); }
        }, options);
        this._coveringTilesDetailsProvider = new AzimuthalEquidistantCoveringTilesDetailsProvider();
    }

    private get _cameraState(): Readonly<CameraState> {
        return this._helper.cameraState;
    }

    clone(): ITransform {
        const clone = new AzimuthalEquidistantPlaneTransform();
        clone._azimuthalness = this._azimuthalness;
        clone.apply(this, false);
        return clone;
    }

    public apply(that: IReadonlyTransform, constrain: boolean): void {
        this._helper.apply(that, constrain);
    }

    get azimuthalness(): number {
        return this._azimuthalness;
    }

    /**
     * Sets how much of the azimuthal projection is shown, 1 is the pure projection. The caller recalculates the matrices.
     */
    setAzimuthalness(azimuthalness: number): void {
        this._azimuthalness = clamp(azimuthalness, 0, 1);
    }

    /**
     * Pitch used for rendering: 0 in the pure azimuthal view, fading in to the real pitch during the transition to mercator.
     */
    private get _effectivePitchInRadians(): number {
        return this._cameraState.pitchInRadians * (1 - this._azimuthalness);
    }

    /**
     * Colatitude of the outer ring of the map, in radians.
     */
    get outerRingColatitude(): number {
        return getAzimuthalOuterRingColatitude();
    }

    /**
     * Pixels per earth radius at the map center (the scale of the plane).
     */
    get planeRadiusPixels(): number {
        const latitude = clamp(this._cameraState.center.lat, -MAX_VALID_LATITUDE, MAX_VALID_LATITUDE);
        const mercatorFactor = 1 / Math.cos(degreesToRadians(latitude));
        const factor = mercatorFactor + (1 - mercatorFactor) * this._azimuthalness;
        return getWorldSize(this._cameraState) / (2 * Math.PI) * factor;
    }

    public get projectionMatrix(): mat4 { return this._projectionMatrix; }

    public get modelViewProjectionMatrix(): mat4 { return this._viewProjMatrix; }

    public get inverseProjectionMatrix(): mat4 { return this._invProjMatrix; }

    public get cameraPosition(): vec3 {
        // Return a copy - don't let outside code mutate our precomputed camera position.
        return vec3.clone(this._cameraPosition);
    }

    get cameraToCenterDistance(): number {
        return this._helper.cameraToCenterDistance;
    }

    getProjectionData(params: ProjectionDataParams): RendererProjectionData {
        const {overscaledTileID, applyGlobeMatrix} = params;
        const mercatorTileCoordinates = getMercatorTileCoordinates(overscaledTileID);
        return {
            mainMatrix: this._viewProjMatrix32f,
            tileMercatorCoords: mercatorTileCoordinates,
            // The azimuthal shader reads the colatitude of the outer ring from the clipping plane uniform.
            clippingPlane: [this.outerRingColatitude, 0, 0, 0],
            projectionTransition: applyGlobeMatrix ? 1 : 0,
            fallbackMatrix: this._viewProjMatrix32f,
            // Like on the globe, the buffer of the z0 tile wraps around the pole onto the tile itself.
            clipAntimeridian: overscaledTileID?.canonical.z === 0,
        };
    }

    private _centerPlanePosition(): [number, number] {
        return lngLatToAzimuthalPlane(this._cameraState.center.lng, this._cameraState.center.lat);
    }

    public isLocationOccluded(lngLat: LngLat, _terrain?: Terrain, _elevation?: number): boolean {
        return lngLat.lat < AZIMUTHAL_SOUTHERN_LIMIT_DEGREES;
    }

    public transformLightDirection(dir: vec3): vec3 {
        const center = this._centerPlanePosition();
        const {east, south} = azimuthalLocalFrame(center[0], center[1]);
        const transformed: vec3 = [
            east[0] * dir[0] + south[0] * dir[1],
            east[1] * dir[0] + south[1] * dir[1],
            dir[2]
        ];
        const normalized: vec3 = [0, 0, 0];
        vec3.normalize(normalized, transformed);
        return normalized;
    }

    /**
     * Ratio of the plane scale to the mercator scale at the equator.
     */
    public getPixelScale(): number {
        return this.planeRadiusPixels / (getWorldSize(this._cameraState) / (2 * Math.PI));
    }

    public getCircleRadiusCorrection(): number {
        return 1 / this.getPixelScale();
    }

    public getPitchedTextCorrection(textAnchorX: number, textAnchorY: number, tileID: UnwrappedTileID): number {
        const mercator = tileCoordinatesToMercatorCoordinates(textAnchorX, textAnchorY, tileID.canonical);
        const ratio = Math.max(azimuthalScaleRatio(mercatorYToColatitude(mercator.y)), 1e-4);
        return this.getCircleRadiusCorrection() / ratio;
    }

    public projectTileCoordinates(x: number, y: number, unwrappedTileID: UnwrappedTileID, elevation?: number): PointProjection {
        const canonical = unwrappedTileID.canonical;
        const plane = projectTileCoordinatesToAzimuthalPlane(x, y, canonical.x, canonical.y, canonical.z);
        const pos: vec4 = [plane[0], plane[1], (elevation ?? 0) / earthRadius, 1];
        vec4.transformMat4(pos, pos, this._viewProjMatrix);
        return {
            point: new Point(pos[0] / pos[3], pos[1] / pos[3]),
            signedDistanceFromCamera: pos[3],
            isOccluded: Math.hypot(plane[0], plane[1]) > this.outerRingColatitude
        };
    }

    /**
     * @param nearFarZ - The depth range to use instead of computing one, by default the camera state's override.
     */
    _calcMatrices(nearFarZ: NearFarZ | null = this._cameraState.nearFarZOverride): void {
        const state = this._cameraState;
        if (!state.width || !state.height) {
            return;
        }

        const radiusPixels = this.planeRadiusPixels;
        const pitch = this._effectivePitchInRadians;
        const offset = getCenterOffset(state);
        const cameraToCenterDistance = state.cameraToCenterDistance;

        if (nearFarZ) {
            this._nearZ = nearFarZ.nearZ;
            this._farZ = nearFarZ.farZ;
        } else {
            // Like mercator: the far plane must reach the top edge of the screen on a flat plane.
            // The real pitch is used, so that the mercator side of a transition is covered as well.
            const realPitch = state.pitchInRadians;
            const halfFov = state.fovInRadians / 2;
            const cameraHeight = Math.max(cameraToCenterDistance * Math.cos(realPitch), 1);
            const minElevationPixels = Math.max(0, -Math.min(state.elevation, state.minElevationForCurrentTile)) * radiusPixels / earthRadius;
            const topRayAngle = Math.min(realPitch + halfFov, degreesToRadians(85));
            this._nearZ = state.height / 50;
            this._farZ = Math.max(cameraToCenterDistance * 1.5, (cameraHeight + minElevationPixels) / Math.cos(topRayAngle) * 1.01);
        }

        const m = createMat4f64();
        mat4.perspective(m, state.fovInRadians, state.width / state.height, this._nearZ, this._farZ);
        this._invProjMatrix = createMat4f64();
        mat4.invert(this._invProjMatrix, m);
        // Apply center of perspective offset
        m[8] = -offset.x * 2 / state.width;
        m[9] = offset.y * 2 / state.height;
        this._projectionMatrix = mat4.clone(m);

        // View matrix: the same camera as in mercator, followed by the placement of the azimuthal plane.
        const view = createIdentityMat4f64();
        mat4.scale(view, view, [1, -1, 1]);
        mat4.translate(view, view, [0, 0, -cameraToCenterDistance]);
        mat4.rotateZ(view, view, -state.rollInRadians);
        mat4.rotateX(view, view, pitch);
        mat4.rotateZ(view, view, -state.bearingInRadians);
        mat4.scale(view, view, [radiusPixels, radiusPixels, radiusPixels]);
        // Move the map center to the origin: after rotating the plane by the center longitude,
        // the center lies on the +y axis at its colatitude, x is the east-west direction at the center.
        // The parallels are stretched by c / sin(c) in this projection. During the transition to mercator this stretch
        // is compensated at the map center, so that both projections coincide there when the transition ends.
        const centerColatitude = degreesToRadians(90 - state.center.lat);
        const parallelStretch = centerColatitude < 1e-6 ? 1 : centerColatitude / Math.sin(centerColatitude);
        const compensation = 1 / parallelStretch + (1 - 1 / parallelStretch) * this._azimuthalness;
        mat4.scale(view, view, [compensation, 1, 1]);
        mat4.translate(view, view, [0, -centerColatitude, -state.elevation / earthRadius]);
        mat4.rotateZ(view, view, degreesToRadians(state.center.lng));

        this._viewProjMatrix = createMat4f64();
        mat4.multiply(this._viewProjMatrix, m, view);
        this._viewProjMatrix32f = new Float32Array(this._viewProjMatrix);
        this._invViewProjMatrix = createMat4f64();
        mat4.invert(this._invViewProjMatrix, this._viewProjMatrix);

        this._pixelMatrix = createMat4f64();
        mat4.multiply(this._pixelMatrix, state.clipSpaceToPixelsMatrix, this._viewProjMatrix);
        this._pixelMatrixInverse = createMat4f64();
        mat4.invert(this._pixelMatrixInverse, this._pixelMatrix);

        const invView = createMat4f64();
        mat4.invert(invView, view);
        const camera: vec4 = [0, 0, 0, 1];
        vec4.transformMat4(camera, camera, invView);
        this._cameraPosition = [camera[0] / camera[3], camera[1] / camera[3], camera[2] / camera[3]];

        this._cachedFrustum = Frustum.fromInvProjectionMatrix(this._invViewProjMatrix, 1, 0);
    }

    calculateFogMatrix(_unwrappedTileID: UnwrappedTileID): mat4 {
        warnOnce('calculateFogMatrix is not supported on azimuthal equidistant projection.');
        return createIdentityMat4f64();
    }

    getVisibleUnwrappedCoordinates(tileID: CanonicalTileID): UnwrappedTileID[] {
        // The azimuthal map has no world copies.
        return [new UnwrappedTileID(0, tileID)];
    }

    getCameraFrustum(): Frustum {
        return this._cachedFrustum;
    }
    getClippingPlane(): vec4 | null {
        return null;
    }
    getCoveringTilesDetailsProvider(): CoveringTilesDetailsProvider {
        return this._coveringTilesDetailsProvider;
    }

    recalculateZoomAndCenter(terrain?: Terrain): void {
        if (terrain) {
            warnOnce('terrain is not supported on the azimuthal equidistant projection.');
            return;
        }
        this._helper.recalculateZoomAndCenter(0);
    }

    maxPitchScaleFactor(): number {
        return 1;
    }

    getCameraPoint(): Point {
        const offset = Math.tan(this._effectivePitchInRadians) * (this.cameraToCenterDistance || 1);
        return this.centerPoint.add(new Point(offset * Math.sin(this.rollInRadians), offset * Math.cos(this.rollInRadians)));
    }

    getCameraAltitude(): number {
        const altitude = Math.cos(this._effectivePitchInRadians) * this.cameraToCenterDistance / this.pixelsPerMeter;
        return altitude + this.elevation;
    }

    getCameraLngLat(): LngLat {
        return azimuthalPlaneToLngLat(this._cameraPosition[0], this._cameraPosition[1], this._cameraState.center.lng);
    }

    get worldCoordinateHelper(): WorldCoordinateHelper {
        return this._helper.worldCoordinateHelper;
    }

    getBounds(): LngLatBounds {
        const xMid = this.width * 0.5;
        const yMid = this.height * 0.5;
        const testPoints = [
            new Point(0, 0),
            new Point(xMid, 0),
            new Point(this.width, 0),
            new Point(this.width, yMid),
            new Point(this.width, this.height),
            new Point(xMid, this.height),
            new Point(0, this.height),
            new Point(0, yMid),
        ];

        // Points on the screen edges might lie on either side of the antimeridian,
        // so the extremes are computed relative to the map center.
        let mostEast = 0, mostWest = 0, mostNorth = 0, mostSouth = 0;
        const center = this.center;
        for (const p of testPoints) {
            const location = this.screenPointToLocation(p);
            const dLng = differenceOfAnglesDegrees(center.lng, location.lng);
            const dLat = location.lat - center.lat;
            mostWest = Math.min(mostWest, dLng);
            mostEast = Math.max(mostEast, dLng);
            mostSouth = Math.min(mostSouth, dLat);
            mostNorth = Math.max(mostNorth, dLat);
        }

        const boundsArray: [number, number, number, number] = [
            center.lng + mostWest,
            Math.max(center.lat + mostSouth, AZIMUTHAL_SOUTHERN_LIMIT_DEGREES),
            center.lng + mostEast,
            Math.min(center.lat + mostNorth, 90)
        ];

        // The north pole may lie inside the screen, then all longitudes are visible.
        const pole = this.locationToScreenPoint(new LngLat(0, 90));
        if (pole.x >= 0 && pole.x <= this.width && pole.y >= 0 && pole.y <= this.height) {
            boundsArray[0] = -180;
            boundsArray[2] = 180;
            boundsArray[3] = 90;
        }

        return new LngLatBounds(boundsArray);
    }

    /**
     * The map center is kept inside the outer ring, and the map can be zoomed out
     * until the whole disk takes up a quarter of the smaller screen dimension.
     */
    defaultConstrain: TransformConstrainFunction = (lngLat, zoom) => {
        const lat = clamp(lngLat.lat, AZIMUTHAL_SOUTHERN_LIMIT_DEGREES, 90);
        let minZoom = this._cameraState.minZoom;
        const screenSize = Math.min(this._cameraState.width, this._cameraState.height);
        if (screenSize > 0) {
            const diskRadiusAtZoom0 = this.outerRingColatitude * this._cameraState.tileSize / (2 * Math.PI);
            minZoom = Math.max(minZoom, scaleZoom(screenSize / 4 / diskRadiusAtZoom0));
        }
        return {
            center: new LngLat(lngLat.lng, lat),
            zoom: clamp(+zoom, Math.min(minZoom, this._cameraState.maxZoom), this._cameraState.maxZoom)
        };
    };

    applyConstrain: TransformConstrainFunction = (lngLat, zoom) => {
        return this._helper.applyConstrain(lngLat, zoom);
    };

    calculateCenterFromCameraLngLatAlt(lngLat: LngLatLike, alt: number, bearing?: number, pitch?: number): {center: LngLat; elevation: number; zoom: number} {
        return this._helper.calculateCenterFromCameraLngLatAlt(lngLat, alt, bearing, pitch);
    }

    /**
     * Camera looking from `from` at `to`. The pure azimuthal view has no pitch, so the camera stands above the target,
     * at the zoom where its distance matches the height of `from`.
     */
    calculateCameraOptionsFromTo(from: LngLatLike, altitudeFrom: number, to: LngLatLike, altitudeTo: number): CameraOptionsFromTo {
        const center = LngLat.convert(to);
        const height = altitudeFrom - altitudeTo;
        if (!(height > 0)) {
            throw new Error('Can\'t calculate camera options with the camera below its target');
        }
        const zoom = scaleZoom(this._cameraState.cameraToCenterDistance / (height / earthRadius) / (this._cameraState.tileSize / (2 * Math.PI)));
        return {center, elevation: altitudeTo, zoom, pitch: 0, bearing: this.bearing};
    }

    /**
     * Moves the map so that `lnglat` appears at `point`, without rotating the disk.
     * The bearing changes by the change of the center longitude, so that the meridians keep their direction on screen.
     */
    setLocationAtPoint(lnglat: LngLat, point: Point, _elevation?: number): void {
        const target = lngLatToAzimuthalPlane(lnglat.lng, lnglat.lat);
        const atPoint = this._screenPointToPlane(point);
        const atCenter = this._screenPointToPlane(this.centerPoint);
        if (!atPoint || !atCenter) {
            return;
        }
        const oldLng = this._cameraState.center.lng;
        const oldBearing = this.bearing;
        const newCenter = azimuthalPlaneToLngLat(
            atCenter[0] + target[0] - atPoint[0],
            atCenter[1] + target[1] - atPoint[1],
            oldLng
        );
        this._helper.setCenter(newCenter);
        this._helper.setBearing(oldBearing + differenceOfAnglesDegrees(oldLng, this._cameraState.center.lng));
    }

    locationToScreenPoint(lnglat: LngLat, terrain?: Terrain): Point {
        const plane = lngLatToAzimuthalPlane(lnglat.lng, lnglat.lat);
        const elevation = terrain ? terrain.getElevationForLngLat(lnglat, this._cameraState.tileZoom) : 0;
        const p: vec4 = [plane[0], plane[1], elevation / earthRadius, 1];
        vec4.transformMat4(p, p, this._pixelMatrix);
        return new Point(p[0] / p[3], p[1] / p[3]);
    }

    /**
     * Intersects the ray through the given screen point with the plane at the given height.
     * @returns plane coordinates, or null if the ray does not hit the plane (above the horizon).
     */
    private _screenPointToPlane(p: Point, elevation: number = 0): [number, number] | null {
        const coord0: vec4 = [p.x, p.y, 0, 1];
        const coord1: vec4 = [p.x, p.y, 1, 1];
        vec4.transformMat4(coord0, coord0, this._pixelMatrixInverse);
        vec4.transformMat4(coord1, coord1, this._pixelMatrixInverse);
        const x0 = coord0[0] / coord0[3];
        const y0 = coord0[1] / coord0[3];
        const z0 = coord0[2] / coord0[3];
        const x1 = coord1[0] / coord1[3];
        const y1 = coord1[1] / coord1[3];
        const z1 = coord1[2] / coord1[3];
        if (z0 === z1) {
            return null;
        }
        const t = (elevation / earthRadius - z0) / (z1 - z0);
        if (!isFinite(t) || t < 0) {
            return null;
        }
        return [x0 + (x1 - x0) * t, y0 + (y1 - y0) * t];
    }

    screenPointToMercatorCoordinate(p: Point, _terrain?: Terrain): MercatorCoordinate {
        return MercatorCoordinate.fromLngLat(this.screenPointToLocation(p));
    }

    screenTerrainPointToMercatorCoordinate(_p: Point, _terrain: Terrain): MercatorCoordinate | null {
        // Terrain is not drawn in the azimuthal view.
        return null;
    }

    screenPointToLocation(p: Point, _terrain?: Terrain): LngLat {
        return this.screenPointToLocationAtElevation(p, 0);
    }

    screenPointToLocationAtElevation(p: Point, elevation: number): LngLat {
        const plane = this._screenPointToPlane(p, elevation) ?? this._centerPlanePosition();
        const location = azimuthalPlaneToLngLat(plane[0], plane[1], this._cameraState.center.lng);
        return new LngLat(wrap(location.lng, -180, 180), location.lat);
    }

    isPointOnMapSurface(p: Point, _terrain?: Terrain): boolean {
        const plane = this._screenPointToPlane(p);
        return !!plane && Math.hypot(plane[0], plane[1]) <= this.outerRingColatitude;
    }

    /**
     * Computes normalized direction of a ray from the camera to the given screen pixel, in plane coordinates.
     */
    getRayDirectionFromPixel(p: Point): vec3 {
        const coord0: vec4 = [p.x, p.y, 0, 1];
        const coord1: vec4 = [p.x, p.y, 1, 1];
        vec4.transformMat4(coord0, coord0, this._pixelMatrixInverse);
        vec4.transformMat4(coord1, coord1, this._pixelMatrixInverse);
        const direction: vec3 = [
            coord1[0] / coord1[3] - coord0[0] / coord0[3],
            coord1[1] / coord1[3] - coord0[1] / coord0[3],
            coord1[2] / coord1[3] - coord0[2] / coord0[3]
        ];
        vec3.normalize(direction, direction);
        return direction;
    }

    getProjectionDataForCustomLayer(applyGlobeMatrix: boolean = true): CustomLayerProjectionData {
        const data = this.getProjectionData({overscaledTileID: new OverscaledTileID(0, 0, 0, 0, 0), applyGlobeMatrix});
        data.tileMercatorCoords = [0, 0, 1, 1];
        return data;
    }

    getFastPathSimpleProjectionMatrix(_tileID: OverscaledTileID): mat4 {
        return undefined;
    }
}

/**
 * Creates a transform for the azimuthal equidistant projection without the transition to mercator.
 */
export function createAzimuthalEquidistantPlaneTransform(options?: TransformOptions): AzimuthalEquidistantPlaneTransform {
    return new AzimuthalEquidistantPlaneTransform(options);
}
