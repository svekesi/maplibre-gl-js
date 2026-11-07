import {ProjectionDefinition, type ProjectionDefinitionSpecification, type ProjectionSpecification} from '@maplibre/maplibre-gl-style-spec';
import {type PossiblyEvaluated, Transitionable, type Transitioning, type TransitionParameters} from '../../style/properties.ts';
import {getProperties, type ProjectionProps, type ProjectionPropsPossiblyEvaluated} from '../../style/projection_properties.g.ts';
import {Evented} from '../../util/evented.ts';
import {EvaluationParameters} from '../../style/evaluation_parameters.ts';
import {MercatorProjection} from './mercator_projection.ts';
import {type PreparedShader, shaders} from '../../shaders/shaders.ts';
import {SubdivisionGranularityExpression, SubdivisionGranularitySetting} from '../../render/subdivision_granularity_settings.ts';
import {createTileMeshWithBuffers, type CreateTileMeshOptions} from '../../util/create_tile_mesh.ts';
import {mercatorWorldCoordinateHelper} from '../mercator_coordinate.ts';

import type {Projection, TileMeshUsage} from './projection.ts';
import type {Context} from '../../webgl/context.ts';
import type {CanonicalTileID} from '../../tile/tile_id.ts';
import type {Mesh} from '../../render/mesh.ts';
import type {WorldCoordinateHelper} from '../transform_interface.ts';

/**
 * The azimuthal shader variant reuses all `#ifdef GLOBE` code paths of the layer shaders,
 * its prelude provides the same functions as the globe prelude.
 */
export const AzimuthalEquidistantShaderDefine = '#define GLOBE\n#define PROJECTION_AZIMUTHAL_EQUIDISTANT';
export const AzimuthalEquidistantShaderVariantKey = 'azimuthal';
export const AzimuthalEquidistantProjectionName = 'azimuthal-equidistant';

const granularitySettingsAzimuthal: SubdivisionGranularitySetting = new SubdivisionGranularitySetting({
    fill: new SubdivisionGranularityExpression(128, 2),
    line: new SubdivisionGranularityExpression(512, 0),
    // Raster tiles always keep some subdivision, the meridians converge towards the pole at every zoom level.
    tile: new SubdivisionGranularityExpression(128, 16),
    // Stencil granularity must never be higher than fill granularity,
    // otherwise we would get seams at zoom levels where stencil has higher granularity than fill.
    stencil: new SubdivisionGranularityExpression(128, 1),
    circle: 3
});

/**
 * Returns how much of the azimuthal projection a (possibly interpolated) projection value contains:
 * 1 is the pure azimuthal projection, 0 is mercator.
 * Other projections (globe, vertical-perspective) are not blended with the azimuthal projection, they are treated as mercator.
 */
export function getAzimuthalness(value: ProjectionDefinitionSpecification | ProjectionDefinition | string): number {
    if (typeof value === 'string') {
        return value === AzimuthalEquidistantProjectionName ? 1 : 0;
    }
    if (value instanceof ProjectionDefinition) {
        const from = value.from === AzimuthalEquidistantProjectionName ? 1 : 0;
        const to = value.to === AzimuthalEquidistantProjectionName ? 1 : 0;
        return from + (to - from) * value.transition;
    }
    return 0;
}

/**
 * Returns true if the projection specification uses the azimuthal equidistant projection,
 * either as a plain name or anywhere inside an expression.
 */
export function isAzimuthalEquidistantSpecification(type: unknown): boolean {
    if (type === AzimuthalEquidistantProjectionName) {
        return true;
    }
    if (Array.isArray(type)) {
        return type.some(isAzimuthalEquidistantSpecification);
    }
    return false;
}

/**
 * Azimuthal equidistant projection centered on the north pole, as used in the emblem of the United Nations.
 *
 * The projection can transition to mercator at higher zoom levels using a projection expression, for example:
 * `["interpolate", ["linear"], ["zoom"], 5, "azimuthal-equidistant", 6, "mercator"]`.
 * While the projection is fully mercator, the fast mercator shaders and meshes are used.
 */
export class AzimuthalEquidistantProjection extends Evented implements Projection {
    properties: PossiblyEvaluated<ProjectionProps, ProjectionPropsPossiblyEvaluated>;

    _transitionable: Transitionable<ProjectionProps>;
    _transitioning: Transitioning<ProjectionProps>;
    _mercatorProjection: MercatorProjection;
    private _tileMeshCache: {[_: string]: Mesh} = {};

    constructor(projection: ProjectionSpecification | undefined, globalState: Record<string, any>) {
        super();
        this._transitionable = new Transitionable(getProperties(), 'projection', globalState);
        this.setProjection(projection);
        this._transitioning = this._transitionable.untransitioned();
        this.recalculate(new EvaluationParameters(0));
        this._mercatorProjection = new MercatorProjection();
    }

    get name(): ProjectionSpecification['type'] {
        return AzimuthalEquidistantProjectionName;
    }

    /**
     * 1 when the map is shown in the azimuthal projection, 0 when it is shown in mercator, values in between during the transition.
     */
    get transitionState(): number {
        return getAzimuthalness(this.properties.get('type'));
    }

    get useAzimuthalRendering(): boolean {
        return this.transitionState > 0;
    }

    get useGlobeControls(): boolean {
        return false;
    }

    get worldCoordinateHelper(): WorldCoordinateHelper {
        return mercatorWorldCoordinateHelper;
    }

    get useSubdivision(): boolean {
        return this.useAzimuthalRendering;
    }

    get shaderVariantName(): string {
        return this.useAzimuthalRendering ? AzimuthalEquidistantShaderVariantKey : this._mercatorProjection.shaderVariantName;
    }

    get shaderDefine(): string {
        return this.useAzimuthalRendering ? AzimuthalEquidistantShaderDefine : this._mercatorProjection.shaderDefine;
    }

    get shaderPreludeCode(): PreparedShader {
        return this.useAzimuthalRendering ? shaders.projectionAzimuthal : this._mercatorProjection.shaderPreludeCode;
    }

    get vertexShaderPreludeCode(): string {
        return shaders.projectionMercator.vertexSource;
    }

    /**
     * Geometry is always subdivided, also while the map shows mercator: tiles loaded at the transition zoom levels
     * are shown in the azimuthal projection as soon as the user zooms out a bit, and their edges must bend then.
     */
    get subdivisionGranularity(): SubdivisionGranularitySetting {
        return granularitySettingsAzimuthal;
    }

    public destroy(): void {
        this._mercatorProjection.destroy();
    }

    public getMeshFromTileID(context: Context, canonical: CanonicalTileID, hasBorder: boolean, allowPoles: boolean, usage: TileMeshUsage): Mesh {
        if (!this.useAzimuthalRendering) {
            return this._mercatorProjection.getMeshFromTileID(context, canonical, hasBorder, allowPoles, usage);
        }
        // Stencil granularity must match fill granularity
        const granularityConfig = usage === 'stencil' ? granularitySettingsAzimuthal.stencil : granularitySettingsAzimuthal.tile;
        const granularity = granularityConfig.getGranularityForZoomLevel(canonical.z);
        const north = (canonical.y === 0) && allowPoles;
        const south = (canonical.y === (1 << canonical.z) - 1) && allowPoles;
        return this._getMesh(context, {
            granularity,
            generateBorders: hasBorder,
            extendToNorthPole: north,
            extendToSouthPole: south,
        });
    }

    private _getMesh(context: Context, options: CreateTileMeshOptions): Mesh {
        const key = `${options.granularity.toString(36)}_${options.generateBorders ? 'b' : ''}${options.extendToNorthPole ? 'n' : ''}${options.extendToSouthPole ? 's' : ''}`;
        if (!(key in this._tileMeshCache)) {
            this._tileMeshCache[key] = createTileMeshWithBuffers(context, options);
        }
        return this._tileMeshCache[key];
    }

    setProjection(projection?: ProjectionSpecification): void {
        this._transitionable.setValue('type', projection?.type || AzimuthalEquidistantProjectionName);
    }

    updateTransitions(parameters: TransitionParameters): void {
        this._transitioning = this._transitionable.transitioned(parameters, this._transitioning);
    }

    hasTransition(): boolean {
        return this._transitioning.hasTransition();
    }

    recalculate(parameters: EvaluationParameters): void {
        this.properties = this._transitioning.possiblyEvaluate(parameters);
    }

    /**
     * Returns how much of the azimuthal projection would be shown at the given zoom level, see {@link transitionState}.
     */
    getTransitionStateAtZoom(zoom: number): number {
        return getAzimuthalness(this._transitioning.possiblyEvaluate(new EvaluationParameters(zoom)).get('type'));
    }
}
