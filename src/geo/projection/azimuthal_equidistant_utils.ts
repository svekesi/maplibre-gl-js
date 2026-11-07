import {LngLat} from '../lng_lat.ts';
import {EXTENT} from '../../data/extent.ts';
import {clamp} from '../../util/util.ts';

/**
 * The azimuthal equidistant projection used here is centered on the north pole, like the map in the emblem of the United Nations.
 *
 * Plane coordinates are measured in radians of arc, i.e. in units of the earth's radius:
 * - the north pole lies at the origin,
 * - the distance of a point from the origin equals its angular distance from the north pole (its colatitude),
 * - the prime meridian points towards +y, longitude 90° east towards +x.
 *
 * The +y axis points "down" on the screen when the map is not rotated, the same way as Y grows towards the south in mercator coordinates.
 * This keeps the plane coordinate system right-handed in the same sense as mercator world coordinates, so the usual camera matrices apply.
 *
 * Forward: c = π/2 - φ, x = c * sin(λ), y = c * cos(λ)
 * Inverse: c = sqrt(x² + y²), λ = atan2(x, y), φ = π/2 - c
 */

/**
 * The parallel at which the azimuthal equidistant map is cut off, in degrees.
 * Everything south of it is clipped away; the outer ring of the map lies on this parallel.
 * The emblem of the United Nations is cut off at 60° south as well.
 */
export const AZIMUTHAL_SOUTHERN_LIMIT_DEGREES = -60;

/**
 * Colatitude (angular distance from the north pole) of the outer ring of the map, in radians.
 */
export function getAzimuthalOuterRingColatitude(): number {
    return (90 - AZIMUTHAL_SOUTHERN_LIMIT_DEGREES) / 180 * Math.PI;
}

/**
 * Computes the colatitude in radians for a mercator Y coordinate (0 is the northern edge of the mercator square, 1 the southern edge).
 * Equivalent to `π/2 - lat`, but numerically stable close to the pole.
 */
export function mercatorYToColatitude(mercatorY: number): number {
    return 2 * Math.atan(Math.exp(Math.PI * (2 * mercatorY - 1)));
}

/**
 * Projects longitude and latitude in degrees to azimuthal equidistant plane coordinates.
 */
export function lngLatToAzimuthalPlane(lng: number, lat: number): [number, number] {
    const colatitude = (90 - lat) / 180 * Math.PI;
    const lambda = lng / 180 * Math.PI;
    return [colatitude * Math.sin(lambda), colatitude * Math.cos(lambda)];
}

/**
 * Inverse of {@link lngLatToAzimuthalPlane}.
 * Points further away from the origin than π (beyond the south pole) are clamped to the south pole.
 * The north pole itself has no defined longitude, `fallbackLng` is returned for it.
 */
export function azimuthalPlaneToLngLat(x: number, y: number, fallbackLng: number = 0): LngLat {
    const colatitude = Math.sqrt(x * x + y * y);
    if (colatitude < 1e-12) {
        return new LngLat(fallbackLng, 90);
    }
    const lng = Math.atan2(x, y) / Math.PI * 180;
    const lat = 90 - clamp(colatitude, 0, Math.PI) / Math.PI * 180;
    return new LngLat(lng, lat);
}

/**
 * Projects mercator coordinates (range 0..1) to azimuthal equidistant plane coordinates.
 */
export function mercatorToAzimuthalPlane(mercatorX: number, mercatorY: number): [number, number] {
    const lambda = mercatorX * Math.PI * 2 - Math.PI;
    const colatitude = mercatorYToColatitude(mercatorY);
    return [colatitude * Math.sin(lambda), colatitude * Math.cos(lambda)];
}

/**
 * Projects a point in tile coordinates (range 0..EXTENT) to azimuthal equidistant plane coordinates.
 */
export function projectTileCoordinatesToAzimuthalPlane(inTileX: number, inTileY: number, tileIdX: number, tileIdY: number, tileIdZ: number): [number, number] {
    const scale = 1.0 / (1 << tileIdZ);
    return mercatorToAzimuthalPlane(
        (tileIdX + inTileX / EXTENT) * scale,
        (tileIdY + inTileY / EXTENT) * scale
    );
}

/**
 * Unit vectors pointing east and south (away from the pole) at the given point of the plane.
 * At the pole itself the directions of the prime meridian are used.
 */
export function azimuthalLocalFrame(x: number, y: number): {east: [number, number]; south: [number, number]} {
    const colatitude = Math.sqrt(x * x + y * y);
    if (colatitude < 1e-12) {
        return {east: [1, 0], south: [0, 1]};
    }
    const sx = x / colatitude;
    const sy = y / colatitude;
    return {east: [sy, -sx], south: [sx, sy]};
}

/**
 * Ratio between the length of a line segment in the azimuthal plane and the length of the same segment in mercator coordinates,
 * both relative to the scale at the equator of mercator. The projection is not conformal, so the ratio differs between
 * the north-south direction (sin c) and the east-west direction (c). This returns the geometric mean of both,
 * which is used to keep line widths and pitched labels at roughly constant size.
 * @param colatitude - colatitude in radians.
 */
export function azimuthalScaleRatio(colatitude: number): number {
    return Math.sqrt(colatitude * Math.sin(colatitude));
}

/**
 * Axis aligned bounding box of a mercator tile in azimuthal plane coordinates.
 * A mercator tile maps to a sector of an annulus. Tiles touching the northern (southern) edge of the mercator square
 * are extended to the north (south) pole, the same way as the tile meshes are.
 * The southern edge is limited to the outer ring of the map.
 * @returns the bounding box, or `null` if the whole tile lies outside the outer ring.
 */
export function getAzimuthalTileBounds(tileX: number, tileY: number, tileZ: number, outerRingColatitude: number): {min: [number, number]; max: [number, number]} | null {
    const tiles = 1 << tileZ;
    const lng0 = tileX / tiles * Math.PI * 2 - Math.PI;
    const lng1 = (tileX + 1) / tiles * Math.PI * 2 - Math.PI;
    const innerColatitude = tileY === 0 ? 0 : mercatorYToColatitude(tileY / tiles);
    if (innerColatitude > outerRingColatitude) {
        return null;
    }
    const outerColatitude = Math.min(tileY === tiles - 1 ? Math.PI : mercatorYToColatitude((tileY + 1) / tiles), outerRingColatitude);

    const min: [number, number] = [Infinity, Infinity];
    const max: [number, number] = [-Infinity, -Infinity];
    const extend = (c: number, lng: number) => {
        const x = c * Math.sin(lng);
        const y = c * Math.cos(lng);
        min[0] = Math.min(min[0], x);
        min[1] = Math.min(min[1], y);
        max[0] = Math.max(max[0], x);
        max[1] = Math.max(max[1], y);
    };
    extend(innerColatitude, lng0);
    extend(innerColatitude, lng1);
    extend(outerColatitude, lng0);
    extend(outerColatitude, lng1);
    // The outer arc reaches its extremes in x and y where it crosses the axes.
    for (const axisLng of [-Math.PI, -Math.PI / 2, 0, Math.PI / 2, Math.PI]) {
        if (axisLng > lng0 && axisLng < lng1) {
            extend(outerColatitude, axisLng);
        }
    }
    return {min, max};
}
