import {OverscaledTileID} from '../../tile/tile_id.ts';
import {Aabb} from '../../util/primitives/aabb.ts';
import {IntersectionResult, type IBoundingVolume} from '../../util/primitives/bounding_volume.ts';
import {LngLat, earthRadius} from '../lng_lat.ts';
import {clamp, MAX_VALID_LATITUDE} from '../../util/util.ts';
import {getAzimuthalOuterRingColatitude, getAzimuthalTileBounds} from './azimuthal_equidistant_utils.ts';

import type {vec4} from 'gl-matrix';
import type {Frustum} from '../../util/primitives/frustum.ts';
import type {MercatorCoordinate} from '../mercator_coordinate.ts';
import type {IReadonlyTransform} from '../transform_interface.ts';
import type {CoveringTilesOptionsInternal} from './covering_tiles.ts';
import type {CoveringTilesDetailsProvider} from './covering_tiles_details_provider.ts';

/**
 * Bounding volume of tiles that lie completely outside the outer ring of the azimuthal map. Never visible.
 */
class OutsideOfMapBoundingVolume implements IBoundingVolume {
    intersectsFrustum(_frustum: Frustum): IntersectionResult {
        return IntersectionResult.None;
    }

    intersectsPlane(_plane: vec4): IntersectionResult {
        return IntersectionResult.None;
    }
}

const outsideOfMap = new OutsideOfMapBoundingVolume();

function distanceToTileSimple(point: number, tile: number, tileSize: number): number {
    const delta = point - tile;
    return (delta < 0) ? -delta : Math.max(0, delta - tileSize);
}

/**
 * Tile selection for the azimuthal equidistant projection.
 * Bounding volumes are axis aligned boxes in plane coordinates (earth radii), see `azimuthal_equidistant_utils.ts`.
 * The same tile zoom level is used for the whole screen, like for the globe at low zoom levels.
 */
export class AzimuthalEquidistantCoveringTilesDetailsProvider implements CoveringTilesDetailsProvider {

    /**
     * The map center may lie on the pole, outside of the mercator square. Like the globe, use the nearest mercator latitude.
     */
    getCenter(transform: IReadonlyTransform): LngLat {
        return new LngLat(transform.center.lng, clamp(transform.center.lat, -MAX_VALID_LATITUDE, MAX_VALID_LATITUDE));
    }

    distanceToTile2d(pointX: number, pointY: number, tileID: {x: number; y: number; z: number}, _bv: IBoundingVolume): number {
        const scale = 1 << tileID.z;
        const tileSize = 1.0 / scale;
        return Math.hypot(
            distanceToTileSimple(pointX, tileID.x / scale, tileSize),
            distanceToTileSimple(pointY, tileID.y / scale, tileSize)
        );
    }

    /**
     * Returns the wrap value for a given tile, computed so that the mercator fallback position of the tile
     * lies next to the map center during a transition to mercator.
     */
    getWrap(centerCoord: MercatorCoordinate, tileID: {x: number; y: number; z: number}, _parentWrap: number): number {
        const scale = 1 << tileID.z;
        const tileMercatorSize = 1.0 / scale;
        const tileX = tileID.x / scale; // In range 0..1
        const distanceCurrent = distanceToTileSimple(centerCoord.x, tileX, tileMercatorSize);
        const distanceLeft = distanceToTileSimple(centerCoord.x, tileX - 1.0, tileMercatorSize);
        const distanceRight = distanceToTileSimple(centerCoord.x, tileX + 1.0, tileMercatorSize);
        const distanceSmallest = Math.min(distanceCurrent, distanceLeft, distanceRight);
        if (distanceSmallest === distanceRight) {
            return 1;
        }
        if (distanceSmallest === distanceLeft) {
            return -1;
        }
        return 0;
    }

    getTileBoundingVolume(tileID: {x: number; y: number; z: number}, wrap: number, elevation: number, options: CoveringTilesOptionsInternal): IBoundingVolume {
        const bounds = getAzimuthalTileBounds(tileID.x, tileID.y, tileID.z, getAzimuthalOuterRingColatitude());
        if (!bounds) {
            return outsideOfMap;
        }
        let minElevation = 0;
        let maxElevation = 0;
        if (options?.terrain) {
            const overscaledTileID = new OverscaledTileID(tileID.z, wrap, tileID.z, tileID.x, tileID.y);
            const minMax = options.terrain.getMinMaxElevation(overscaledTileID);
            minElevation = minMax.minElevation ?? Math.min(0, elevation);
            maxElevation = minMax.maxElevation ?? Math.max(0, elevation);
        }
        return new Aabb(
            [bounds.min[0], bounds.min[1], minElevation / earthRadius],
            [bounds.max[0], bounds.max[1], maxElevation / earthRadius]
        );
    }

    allowVariableZoom(_transform: IReadonlyTransform, _options: CoveringTilesOptionsInternal): boolean {
        // The camera is not pitched in the azimuthal view.
        return false;
    }

    allowWorldCopies(): boolean {
        return false;
    }

    prepareNextFrame(): void {
        // Do nothing, bounding volumes are cheap to compute.
    }
}
