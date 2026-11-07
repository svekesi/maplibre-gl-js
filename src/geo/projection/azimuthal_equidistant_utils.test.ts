import {describe, expect, test} from 'vitest';
import {EXTENT} from '../../data/extent.ts';
import {mercatorYfromLat} from '../mercator_coordinate.ts';
import {tileCoordinatesToLocation} from './mercator_utils.ts';
import {CanonicalTileID} from '../../tile/tile_id.ts';
import {expectToBeCloseToArray} from '../../util/test/util.ts';
import {
    AZIMUTHAL_SOUTHERN_LIMIT_DEGREES,
    azimuthalLocalFrame,
    azimuthalPlaneToLngLat,
    azimuthalScaleRatio,
    getAzimuthalOuterRingColatitude,
    getAzimuthalTileBounds,
    lngLatToAzimuthalPlane,
    mercatorToAzimuthalPlane,
    mercatorYToColatitude,
    projectTileCoordinatesToAzimuthalPlane
} from './azimuthal_equidistant_utils.ts';

/** Great circle distance in radians. */
function angularDistance(lng1: number, lat1: number, lng2: number, lat2: number): number {
    const toRad = Math.PI / 180;
    const dLat = (lat2 - lat1) * toRad;
    const dLng = (lng2 - lng1) * toRad;
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.sin(dLng / 2) ** 2;
    return 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

describe('azimuthal equidistant utils', () => {
    describe('forward projection', () => {
        test('north pole is the origin', () => {
            expectToBeCloseToArray(lngLatToAzimuthalPlane(0, 90), [0, 0]);
            expectToBeCloseToArray(lngLatToAzimuthalPlane(123, 90), [0, 0]);
        });

        test('prime meridian points down (+y), 90° east to the right (+x)', () => {
            expectToBeCloseToArray(lngLatToAzimuthalPlane(0, 0), [0, Math.PI / 2]);
            expectToBeCloseToArray(lngLatToAzimuthalPlane(90, 0), [Math.PI / 2, 0]);
            expectToBeCloseToArray(lngLatToAzimuthalPlane(180, 0), [0, -Math.PI / 2]);
            expectToBeCloseToArray(lngLatToAzimuthalPlane(-90, 0), [-Math.PI / 2, 0]);
        });

        test('south pole is the outermost ring', () => {
            const plane = lngLatToAzimuthalPlane(45, -90);
            expect(Math.hypot(plane[0], plane[1])).toBeCloseTo(Math.PI, 10);
        });

        test('distance from the origin equals the great circle distance from the north pole', () => {
            for (const [lng, lat] of [[8.63, 48.17], [11.57, 48.14], [7.66, 45.98], [-74, 40.7], [151.2, -33.9], [-58.4, -34.6], [0, -60]]) {
                const plane = lngLatToAzimuthalPlane(lng, lat);
                expect(Math.hypot(plane[0], plane[1])).toBeCloseTo(angularDistance(0, 90, lng, lat), 10);
            }
        });

        test('meridians are straight lines through the origin', () => {
            const a = lngLatToAzimuthalPlane(30, 10);
            const b = lngLatToAzimuthalPlane(30, 70);
            expect(Math.atan2(a[0], a[1])).toBeCloseTo(Math.atan2(b[0], b[1]), 10);
        });

        test('mercator Y to colatitude matches the latitude', () => {
            for (const lat of [-85, -60, -10, 0, 33.3, 48.2, 80, 85]) {
                expect(mercatorYToColatitude(mercatorYfromLat(lat))).toBeCloseTo((90 - lat) / 180 * Math.PI, 10);
            }
        });

        test('mercator coordinates', () => {
            expectToBeCloseToArray(mercatorToAzimuthalPlane(0.5, 0.5), [0, Math.PI / 2]);
            expectToBeCloseToArray(mercatorToAzimuthalPlane(0.75, 0.5), [Math.PI / 2, 0]);
        });

        test('tile coordinates agree with the location of the tile point', () => {
            const tileID = new CanonicalTileID(7, 66, 44);
            for (const [x, y] of [[0, 0], [EXTENT, 0], [EXTENT / 3, EXTENT / 7], [EXTENT, EXTENT]]) {
                const location = tileCoordinatesToLocation(x, y, tileID);
                expectToBeCloseToArray(
                    projectTileCoordinatesToAzimuthalPlane(x, y, tileID.x, tileID.y, tileID.z),
                    lngLatToAzimuthalPlane(location.lng, location.lat),
                    9
                );
            }
        });
    });

    describe('inverse projection', () => {
        test('round trip', () => {
            for (let lng = -179; lng < 180; lng += 17) {
                for (let lat = -89; lat < 90; lat += 11) {
                    const plane = lngLatToAzimuthalPlane(lng, lat);
                    const location = azimuthalPlaneToLngLat(plane[0], plane[1]);
                    expect(location.lng).toBeCloseTo(lng, 8);
                    expect(location.lat).toBeCloseTo(lat, 8);
                }
            }
        });

        test('north pole returns the fallback longitude', () => {
            const location = azimuthalPlaneToLngLat(0, 0, 8.6);
            expect(location.lng).toBe(8.6);
            expect(location.lat).toBe(90);
        });

        test('points beyond the south pole are clamped to it', () => {
            const location = azimuthalPlaneToLngLat(0, 4);
            expect(location.lat).toBeCloseTo(-90, 10);
        });
    });

    describe('local frame', () => {
        test('east and south are orthonormal', () => {
            for (const [lng, lat] of [[0, 45], [100, 10], [-170, -40]]) {
                const plane = lngLatToAzimuthalPlane(lng, lat);
                const {east, south} = azimuthalLocalFrame(plane[0], plane[1]);
                expect(Math.hypot(east[0], east[1])).toBeCloseTo(1, 10);
                expect(Math.hypot(south[0], south[1])).toBeCloseTo(1, 10);
                expect(east[0] * south[0] + east[1] * south[1]).toBeCloseTo(0, 10);
            }
        });

        test('east points towards increasing longitude, south towards decreasing latitude', () => {
            const plane = lngLatToAzimuthalPlane(20, 50);
            const {east, south} = azimuthalLocalFrame(plane[0], plane[1]);
            const towardsEast = lngLatToAzimuthalPlane(20.01, 50);
            const towardsSouth = lngLatToAzimuthalPlane(20, 49.99);
            expect((towardsEast[0] - plane[0]) * east[0] + (towardsEast[1] - plane[1]) * east[1]).toBeGreaterThan(0);
            expect((towardsSouth[0] - plane[0]) * south[0] + (towardsSouth[1] - plane[1]) * south[1]).toBeGreaterThan(0);
        });

        test('scale ratio is the geometric mean of meridian and parallel scale', () => {
            const c = 1.2;
            expect(azimuthalScaleRatio(c)).toBeCloseTo(Math.sqrt(Math.sin(c) * c), 10);
            expect(azimuthalScaleRatio(0)).toBe(0);
        });
    });

    describe('tile bounds', () => {
        const ring = getAzimuthalOuterRingColatitude();

        test('outer ring lies on the southern limit', () => {
            expect(ring).toBeCloseTo((90 - AZIMUTHAL_SOUTHERN_LIMIT_DEGREES) / 180 * Math.PI, 10);
        });

        test('the root tile covers the whole disk', () => {
            const bounds = getAzimuthalTileBounds(0, 0, 0, ring);
            expectToBeCloseToArray(bounds.min, [-ring, -ring]);
            expectToBeCloseToArray(bounds.max, [ring, ring]);
        });

        test('tiles south of the outer ring are dropped', () => {
            // At zoom 3, rows 6 and 7 lie south of 60°S.
            expect(getAzimuthalTileBounds(2, 6, 3, ring)).toBeNull();
            expect(getAzimuthalTileBounds(5, 7, 3, ring)).toBeNull();
            expect(getAzimuthalTileBounds(5, 5, 3, ring)).not.toBeNull();
        });

        test('bounds contain all points of the tile', () => {
            for (const [x, y, z] of [[0, 0, 1], [1, 1, 1], [3, 2, 3], [7, 0, 3], [33, 22, 6], [12, 30, 5]]) {
                const bounds = getAzimuthalTileBounds(x, y, z, ring);
                for (let i = 0; i <= 16; i++) {
                    for (let j = 0; j <= 16; j++) {
                        const p = projectTileCoordinatesToAzimuthalPlane(i * EXTENT / 16, j * EXTENT / 16, x, y, z);
                        if (Math.hypot(p[0], p[1]) > ring) continue;
                        expect(p[0]).toBeGreaterThanOrEqual(bounds.min[0] - 1e-9);
                        expect(p[1]).toBeGreaterThanOrEqual(bounds.min[1] - 1e-9);
                        expect(p[0]).toBeLessThanOrEqual(bounds.max[0] + 1e-9);
                        expect(p[1]).toBeLessThanOrEqual(bounds.max[1] + 1e-9);
                    }
                }
            }
        });

        test('tiles at the northern edge include the pole', () => {
            const bounds = getAzimuthalTileBounds(1, 0, 2, ring);
            expect(bounds.min[0]).toBeLessThanOrEqual(0);
            expect(bounds.min[1]).toBeLessThanOrEqual(0);
            expect(bounds.max[0]).toBeGreaterThanOrEqual(0);
            expect(bounds.max[1]).toBeGreaterThanOrEqual(0);
        });
    });
});
