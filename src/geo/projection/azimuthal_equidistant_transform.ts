import {TransformHelper} from '../transform_helper.ts';
import {MercatorTransform} from './mercator_transform.ts';
import {AzimuthalEquidistantPlaneTransform} from './azimuthal_equidistant_plane_transform.ts';
import {lerp} from '../../util/util.ts';

import type {CameraState} from '../camera_state.ts';
import type {LngLat, LngLatLike} from '../lng_lat.ts';
import type {mat2, mat4, vec3, vec4} from 'gl-matrix';
import type {OverscaledTileID, UnwrappedTileID, CanonicalTileID} from '../../tile/tile_id.ts';
import type Point from '@mapbox/point-geometry';
import type {MercatorCoordinate} from '../mercator_coordinate.ts';
import type {LngLatBounds} from '../lng_lat_bounds.ts';
import type {Frustum} from '../../util/primitives/frustum.ts';
import type {Terrain} from '../../render/terrain.ts';
import type {PointProjection} from '../../symbol/projection.ts';
import type {CameraOptionsFromTo, IReadonlyTransform, ITransform, NearFarZ, TransformConstrainFunction, WorldCoordinateHelper} from '../transform_interface.ts';
import type {TransformOptions} from '../transform_helper.ts';
import type {PaddingOptions} from '../edge_insets.ts';
import type {CustomLayerProjectionData, ProjectionDataParams, RendererProjectionData} from './projection_data.ts';
import type {CoveringTilesDetailsProvider} from './covering_tiles_details_provider.ts';

/**
 * Transform for the azimuthal equidistant projection that moves between the azimuthal plane and mercator,
 * the same way as {@link GlobeTransform} moves between vertical perspective and mercator.
 * Both child transforms share this transform's camera state.
 */
export class AzimuthalEquidistantTransform implements ITransform {
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
        return this._helper.pixelsPerMeter;
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
    resize(width: number, height: number, constrainTransform: boolean = true): void {
        this._helper.resize(width, height, constrainTransform);
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
        return this.currentTransform.getCameraQueryGeometry(queryGeometry);
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
    get cameraToCenterDistance(): number {
        return this._helper.cameraToCenterDistance;
    }
    get constrainOverride(): TransformConstrainFunction {
        return this._helper.constrainOverride;
    }
    public get nearZ(): number {
        return this.currentTransform.nearZ;
    }
    public get farZ(): number {
        return this.currentTransform.farZ;
    }
    public get nearFarZOverride(): NearFarZ | null {
        return this._helper.nearFarZOverride;
    }
    public get autoCalculateNearFarZ(): boolean {
        return this._helper.autoCalculateNearFarZ;
    }
    //
    // Implementation of the azimuthal transform
    //

    /**
     * True when the azimuthal render path should be used instead of the simpler mercator rendering.
     */
    get isAzimuthalRendering(): boolean {
        return this._azimuthalness > 0;
    }

    setTransitionState(azimuthalness: number): void {
        if (azimuthalness === undefined || azimuthalness === null) {
            return;
        }
        this._azimuthalness = azimuthalness;
        this._planeTransform.setAzimuthalness(azimuthalness);
        this._calcMatrices();
        this._planeTransform.getCoveringTilesDetailsProvider().prepareNextFrame();
        this._mercatorTransform.getCoveringTilesDetailsProvider().prepareNextFrame();
    }

    private get currentTransform(): ITransform {
        return this.isAzimuthalRendering ? this._planeTransform : this._mercatorTransform;
    }

    /**
     * Value 0 is mercator, value 1 is the azimuthal projection, anything between is an interpolation between the two projections.
     */
    private _azimuthalness: number = 1.0;
    private _mercatorTransform: MercatorTransform;
    private _planeTransform: AzimuthalEquidistantPlaneTransform;

    public constructor(options?: TransformOptions) {
        this._helper = new TransformHelper({
            calcMatrices: () => this._calcMatrices(),
            defaultConstrain: (center, zoom) => { return this.defaultConstrain(center, zoom); }
        }, options);
        this._azimuthalness = 1; // When transform is cloned for use in symbols, `_updateAnimation` function which usually sets this value never gets called.
        this._mercatorTransform = new MercatorTransform(undefined, this._helper);
        this._planeTransform = new AzimuthalEquidistantPlaneTransform(undefined, this._helper);
    }

    private get _cameraState(): Readonly<CameraState> {
        return this._helper.cameraState;
    }

    clone(): ITransform {
        const clone = new AzimuthalEquidistantTransform();
        clone._azimuthalness = this._azimuthalness;
        clone._planeTransform.setAzimuthalness(this._azimuthalness);
        clone.apply(this, false);
        return clone;
    }

    public apply(that: IReadonlyTransform, constrain: boolean): void {
        this._helper.apply(that, constrain);
    }

    public get projectionMatrix(): mat4 { return this.currentTransform.projectionMatrix; }

    public get modelViewProjectionMatrix(): mat4 { return this.currentTransform.modelViewProjectionMatrix; }

    public get inverseProjectionMatrix(): mat4 { return this.currentTransform.inverseProjectionMatrix; }

    public get cameraPosition(): vec3 { return this.currentTransform.cameraPosition; }

    getProjectionData(params: ProjectionDataParams): RendererProjectionData {
        const mercatorProjectionData = this._mercatorTransform.getProjectionData(params);
        const planeProjectionData = this._planeTransform.getProjectionData(params);

        return {
            mainMatrix: this.isAzimuthalRendering ? planeProjectionData.mainMatrix : mercatorProjectionData.mainMatrix,
            clippingPlane: planeProjectionData.clippingPlane,
            tileMercatorCoords: planeProjectionData.tileMercatorCoords,
            projectionTransition: params.applyGlobeMatrix ? this._azimuthalness : 0,
            fallbackMatrix: mercatorProjectionData.fallbackMatrix,
            clipAntimeridian: planeProjectionData.clipAntimeridian,
        };
    }

    /** {@inheritDoc ITransform.isLocationOccluded} */
    public isLocationOccluded(lngLat: LngLat, terrain?: Terrain, elevation?: number): boolean {
        return this.currentTransform.isLocationOccluded(lngLat, terrain, elevation);
    }

    public transformLightDirection(dir: vec3): vec3 {
        return this.currentTransform.transformLightDirection(dir);
    }

    public getPixelScale(): number {
        return lerp(this._mercatorTransform.getPixelScale(), this._planeTransform.getPixelScale(), this._azimuthalness);
    }

    public getCircleRadiusCorrection(): number {
        return this.currentTransform.getCircleRadiusCorrection();
    }

    public getPitchedTextCorrection(textAnchorX: number, textAnchorY: number, tileID: UnwrappedTileID): number {
        const mercatorCorrection = this._mercatorTransform.getPitchedTextCorrection(textAnchorX, textAnchorY, tileID);
        const planeCorrection = this._planeTransform.getPitchedTextCorrection(textAnchorX, textAnchorY, tileID);
        return lerp(mercatorCorrection, planeCorrection, this._azimuthalness);
    }

    public projectTileCoordinates(x: number, y: number, unwrappedTileID: UnwrappedTileID, elevation?: number): PointProjection {
        return this.currentTransform.projectTileCoordinates(x, y, unwrappedTileID, elevation);
    }

    /**
     * The plane computes its depth range first, and while the azimuthal projection is rendering, mercator uses that range
     * instead of its own, which keeps the two render paths at the same depth across the transition.
     */
    private _calcMatrices(): void {
        if (!this._cameraState.width || !this._cameraState.height) {
            return;
        }
        const plane = this._planeTransform;
        plane._calcMatrices();
        const nearFarZ = this.isAzimuthalRendering ? {nearZ: plane.nearZ, farZ: plane.farZ} : this._cameraState.nearFarZOverride;
        this._mercatorTransform._calcMatrices(nearFarZ);
    }

    calculateFogMatrix(unwrappedTileID: UnwrappedTileID): mat4 {
        return this.currentTransform.calculateFogMatrix(unwrappedTileID);
    }

    getVisibleUnwrappedCoordinates(tileID: CanonicalTileID): UnwrappedTileID[] {
        return this.currentTransform.getVisibleUnwrappedCoordinates(tileID);
    }

    getCameraFrustum(): Frustum {
        return this.currentTransform.getCameraFrustum();
    }
    getClippingPlane(): vec4 | null {
        return this.currentTransform.getClippingPlane();
    }
    getCoveringTilesDetailsProvider(): CoveringTilesDetailsProvider {
        return this.currentTransform.getCoveringTilesDetailsProvider();
    }

    recalculateZoomAndCenter(terrain?: Terrain): void {
        this.currentTransform.recalculateZoomAndCenter(terrain);
    }

    maxPitchScaleFactor(): number {
        return this._mercatorTransform.maxPitchScaleFactor();
    }

    getCameraPoint(): Point {
        // The azimuthal view suppresses pitch, see the plane transform.
        return this.currentTransform.getCameraPoint();
    }

    /** The camera of the child that renders the current frame. */
    getCameraAltitude(): number {
        return this.currentTransform.getCameraAltitude();
    }

    /** See {@link getCameraAltitude}. */
    getCameraLngLat(): LngLat {
        return this.currentTransform.getCameraLngLat();
    }

    get worldCoordinateHelper(): WorldCoordinateHelper {
        return this._helper.worldCoordinateHelper;
    }

    getBounds(): LngLatBounds {
        return this.currentTransform.getBounds();
    }

    defaultConstrain: TransformConstrainFunction = (lngLat, zoom) => {
        return this.currentTransform.defaultConstrain(lngLat, zoom);
    };

    applyConstrain: TransformConstrainFunction = (lngLat, zoom) => {
        return this._helper.applyConstrain(lngLat, zoom);
    };

    calculateCenterFromCameraLngLatAlt(lngLat: LngLatLike, alt: number, bearing?: number, pitch?: number): {center: LngLat; elevation: number; zoom: number} {
        return this._helper.calculateCenterFromCameraLngLatAlt(lngLat, alt, bearing, pitch);
    }

    /** See {@link getCameraAltitude}. */
    calculateCameraOptionsFromTo(from: LngLatLike, altitudeFrom: number, to: LngLatLike, altitudeTo: number): CameraOptionsFromTo {
        return this.currentTransform.calculateCameraOptionsFromTo(from, altitudeFrom, to, altitudeTo);
    }

    /**
     * Note: automatically adjusts zoom to keep planet size consistent
     * (same size before and after a {@link setLocationAtPoint} call).
     */
    setLocationAtPoint(lnglat: LngLat, point: Point, elevation?: number): void {
        this.currentTransform.setLocationAtPoint(lnglat, point, elevation);
    }

    locationToScreenPoint(lnglat: LngLat, terrain?: Terrain): Point {
        return this.currentTransform.locationToScreenPoint(lnglat, terrain);
    }

    screenPointToMercatorCoordinate(p: Point, terrain?: Terrain): MercatorCoordinate {
        return this.currentTransform.screenPointToMercatorCoordinate(p, terrain);
    }

    /** {@inheritDoc ITransform.screenTerrainPointToMercatorCoordinate} */
    screenTerrainPointToMercatorCoordinate(p: Point, terrain: Terrain): MercatorCoordinate | null {
        return this.currentTransform.screenTerrainPointToMercatorCoordinate(p, terrain);
    }

    screenPointToLocation(p: Point, terrain?: Terrain): LngLat {
        return this.currentTransform.screenPointToLocation(p, terrain);
    }

    screenPointToLocationAtElevation(p: Point, elevation: number): LngLat {
        return this.currentTransform.screenPointToLocationAtElevation(p, elevation);
    }

    isPointOnMapSurface(p: Point, terrain?: Terrain): boolean {
        return this.currentTransform.isPointOnMapSurface(p, terrain);
    }

    /**
     * Computes normalized direction of a ray from the camera to the given screen pixel.
     *
     * Always answered by the plane child, in plane coordinates; the mercator transform does not implement it.
     */
    getRayDirectionFromPixel(p: Point): vec3 {
        return this._planeTransform.getRayDirectionFromPixel(p);
    }

    getProjectionDataForCustomLayer(applyGlobeMatrix: boolean = true): CustomLayerProjectionData {
        const mercatorData = this._mercatorTransform.getProjectionDataForCustomLayer(applyGlobeMatrix);

        if (!this.isAzimuthalRendering) {
            return mercatorData;
        }

        const planeData = this._planeTransform.getProjectionDataForCustomLayer(applyGlobeMatrix);
        planeData.fallbackMatrix = mercatorData.mainMatrix;
        planeData.projectionTransition = this._azimuthalness;
        return planeData;
    }

    getFastPathSimpleProjectionMatrix(tileID: OverscaledTileID): mat4 {
        return this.currentTransform.getFastPathSimpleProjectionMatrix(tileID);
    }
}

/**
 * Creates a transform for the azimuthal equidistant projection with its transition to mercator.
 */
export function createAzimuthalEquidistantTransform(options?: TransformOptions): AzimuthalEquidistantTransform {
    return new AzimuthalEquidistantTransform(options);
}
