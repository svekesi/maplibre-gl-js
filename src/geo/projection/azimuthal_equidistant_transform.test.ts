import {describe, expect, test} from 'vitest';
import Point from '@mapbox/point-geometry';
import {ProjectionDefinition} from '@maplibre/maplibre-gl-style-spec';
import {LngLat} from '../lng_lat.ts';
import {OverscaledTileID} from '../../tile/tile_id.ts';
import {EXTENT} from '../../data/extent.ts';
import {MercatorTransform} from './mercator_transform.ts';
import {tileCoordinatesToLocation} from './mercator_utils.ts';
import {coveringTiles} from './covering_tiles.ts';
import {AzimuthalEquidistantTransform} from './azimuthal_equidistant_transform.ts';
import {AzimuthalEquidistantPlaneTransform} from './azimuthal_equidistant_plane_transform.ts';
import {AzimuthalEquidistantProjection, getAzimuthalness, isAzimuthalEquidistantSpecification} from './azimuthal_equidistant_projection.ts';
import {AzimuthalEquidistantCameraHelper} from './azimuthal_equidistant_camera_helper.ts';
import {AzimuthalEquidistantCoveringTilesDetailsProvider} from './azimuthal_equidistant_covering_tiles_details_provider.ts';
import {AZIMUTHAL_SOUTHERN_LIMIT_DEGREES} from './azimuthal_equidistant_utils.ts';
import {createProjectionFromName} from './projection_factory.ts';
import {GlobeProjection} from './globe_projection.ts';
import {IntersectionResult} from '../../util/primitives/bounding_volume.ts';

const transitionExpression = ['interpolate', ['linear'], ['zoom'], 5, 'azimuthal-equidistant', 6, 'mercator'];

function createTransform(center: LngLat = new LngLat(0, 90), zoom: number = 1, bearing: number = 0): AzimuthalEquidistantTransform {
    const transform = new AzimuthalEquidistantTransform();
    transform.resize(640, 480);
    transform.setTransitionState(1);
    transform.setZoom(zoom);
    transform.setCenter(center);
    transform.setBearing(bearing);
    return transform;
}

function expectPointsClose(actual: Point, expected: Point, precision: number = 6) {
    expect(actual.x).toBeCloseTo(expected.x, precision);
    expect(actual.y).toBeCloseTo(expected.y, precision);
}

describe('AzimuthalEquidistantTransform', () => {
    describe('project', () => {
        test('the map center is in the middle of the screen', () => {
            for (const center of [new LngLat(0, 90), new LngLat(8.63, 48.17), new LngLat(-120, -30)]) {
                const transform = createTransform(center, 2, 33);
                expectPointsClose(transform.locationToScreenPoint(center), new Point(320, 240));
            }
        });

        test('UN view: prime meridian down, east to the right', () => {
            const transform = createTransform(new LngLat(0, 90), 1);
            const greenwich = transform.locationToScreenPoint(new LngLat(0, 60));
            const east = transform.locationToScreenPoint(new LngLat(90, 60));
            const dateLine = transform.locationToScreenPoint(new LngLat(180, 60));
            const west = transform.locationToScreenPoint(new LngLat(-90, 60));
            expect(greenwich.x).toBeCloseTo(320, 6);
            expect(greenwich.y).toBeGreaterThan(240);
            expect(east.x).toBeGreaterThan(320);
            expect(east.y).toBeCloseTo(240, 6);
            expect(dateLine.y).toBeLessThan(240);
            expect(west.x).toBeLessThan(320);
        });

        test('equidistant: 30° of latitude are the same distance everywhere on the screen', () => {
            const transform = createTransform(new LngLat(0, 90), 1);
            const lengths = [0, 77, 160, -100].map(lng => transform.locationToScreenPoint(new LngLat(lng, 30)).dist(new Point(320, 240)));
            for (const length of lengths) {
                expect(length).toBeCloseTo(lengths[0], 6);
            }
            // 60° of arc at the scale of the mercator equator: worldSize / 360 pixels per degree
            expect(lengths[0]).toBeCloseTo(60 * transform.worldSize / 360, 6);
        });

        test('bearing 0 keeps north up at the center, also far away from the prime meridian', () => {
            const transform = createTransform(new LngLat(100, 40), 4);
            const north = transform.locationToScreenPoint(new LngLat(100, 41));
            expect(north.x).toBeCloseTo(320, 6);
            expect(north.y).toBeLessThan(240);
        });

        test('bearing 90 turns north to the left', () => {
            const transform = createTransform(new LngLat(8.6, 48.2), 4, 90);
            const north = transform.locationToScreenPoint(new LngLat(8.6, 49.2));
            expect(north.y).toBeCloseTo(240, 6);
            expect(north.x).toBeLessThan(320);
        });

        test('locations south of the outer ring are occluded', () => {
            const transform = createTransform();
            expect(transform.isLocationOccluded(new LngLat(0, AZIMUTHAL_SOUTHERN_LIMIT_DEGREES - 1))).toBe(true);
            expect(transform.isLocationOccluded(new LngLat(0, AZIMUTHAL_SOUTHERN_LIMIT_DEGREES + 1))).toBe(false);
        });

        test('tile coordinates project to the same point as their location', () => {
            const transform = createTransform(new LngLat(10, 50), 3, 20);
            const tileID = new OverscaledTileID(3, 0, 3, 4, 2);
            const projected = transform.projectTileCoordinates(EXTENT / 2, EXTENT / 4, tileID.toUnwrapped(), null);
            const pixels = new Point((projected.point.x + 1) / 2 * 640, (1 - projected.point.y) / 2 * 480);
            const expected = transform.locationToScreenPoint(tileCoordinatesToLocation(EXTENT / 2, EXTENT / 4, tileID.canonical));
            expectPointsClose(pixels, expected, 4);
            expect(projected.isOccluded).toBe(false);
        });
    });

    describe('unproject', () => {
        test('round trip', () => {
            for (const [center, zoom, bearing] of [[new LngLat(0, 90), 1, 0], [new LngLat(8.6, 48.2), 5, 0], [new LngLat(-70, -20), 3, -45], [new LngLat(170, 60), 2.5, 120]] as Array<[LngLat, number, number]>) {
                const transform = createTransform(center, zoom, bearing);
                for (const point of [new Point(0, 0), new Point(640, 0), new Point(320, 240), new Point(100, 400), new Point(640, 480)]) {
                    const location = transform.screenPointToLocation(point);
                    expectPointsClose(transform.locationToScreenPoint(location), point, 5);
                }
            }
        });

        test('screen center unprojects to the map center', () => {
            const transform = createTransform(new LngLat(8.6, 48.2), 6, 10);
            const location = transform.screenPointToLocation(new Point(320, 240));
            expect(location.lng).toBeCloseTo(8.6, 8);
            expect(location.lat).toBeCloseTo(48.2, 8);
        });

        test('points outside of the disk are not on the map surface', () => {
            const transform = createTransform(new LngLat(0, 90), 0.5);
            expect(transform.isPointOnMapSurface(new Point(320, 240))).toBe(true);
            expect(transform.isPointOnMapSurface(new Point(0, 0))).toBe(false);
        });
    });

    describe('setLocationAtPoint', () => {
        test('moves the location to the point', () => {
            const transform = createTransform(new LngLat(0, 90), 2);
            const location = new LngLat(30, 50);
            const point = new Point(200, 300);
            transform.setLocationAtPoint(location, point);
            expectPointsClose(transform.locationToScreenPoint(location), point, 4);
        });

        test('pans without rotating the disk', () => {
            const transform = createTransform(new LngLat(0, 90), 2);
            const other = new LngLat(-60, 40);
            const location = transform.screenPointToLocation(new Point(320, 240));
            const before = transform.locationToScreenPoint(other);
            // Drag the pole 150 px to the left and 40 px down.
            transform.setLocationAtPoint(location, new Point(170, 280));
            const after = transform.locationToScreenPoint(other);
            expect(after.x - before.x).toBeCloseTo(-150, 4);
            expect(after.y - before.y).toBeCloseTo(40, 4);
        });

        test('bearing follows the center longitude while panning', () => {
            const transform = createTransform(new LngLat(0, 70), 3);
            transform.setLocationAtPoint(transform.screenPointToLocation(new Point(320, 240)), new Point(100, 240));
            const center = transform.center;
            expect(center.lng).toBeGreaterThan(0);
            expect(transform.bearing).toBeCloseTo(center.lng, 6);
        });

        test('crossing the pole keeps the view continuous', () => {
            const transform = createTransform(new LngLat(0, 85), 3);
            const other = new LngLat(90, 80);
            const before = transform.locationToScreenPoint(other);
            const location = transform.screenPointToLocation(new Point(320, 240));
            // Move the map down far enough for the center to cross the pole.
            transform.setLocationAtPoint(location, new Point(320, 240 + 140));
            const after = transform.locationToScreenPoint(other);
            expect(after.x - before.x).toBeCloseTo(0, 4);
            expect(after.y - before.y).toBeCloseTo(140, 4);
        });
    });

    describe('constraints', () => {
        test('center stays inside the outer ring', () => {
            const transform = createTransform(new LngLat(0, -80), 3);
            expect(transform.center.lat).toBeCloseTo(AZIMUTHAL_SOUTHERN_LIMIT_DEGREES, 10);
        });

        test('the disk does not shrink below a quarter of the screen', () => {
            const transform = createTransform(new LngLat(0, 90), -5);
            const ringPoint = transform.locationToScreenPoint(new LngLat(0, AZIMUTHAL_SOUTHERN_LIMIT_DEGREES));
            expect(ringPoint.dist(new Point(320, 240))).toBeGreaterThanOrEqual(480 / 4 - 1e-6);
        });

        test('pure azimuthal view is not pitched', () => {
            const transform = createTransform(new LngLat(8.6, 48.2), 4);
            transform.setPitch(50);
            expect(transform.pitch).toBe(50);
            const left = transform.locationToScreenPoint(new LngLat(8.6, 49));
            const right = transform.locationToScreenPoint(new LngLat(8.6, 47.4));
            // Without pitch the distances to the north and to the south are equal.
            expect(240 - left.y).toBeCloseTo(right.y - 240, 0);
        });
    });

    describe('transition to mercator', () => {
        test('projection data carries the transition', () => {
            const transform = createTransform(new LngLat(8.6, 48.2), 5.5);
            transform.setTransitionState(0.5);
            const data = transform.getProjectionData({overscaledTileID: new OverscaledTileID(5, 0, 5, 16, 11), applyGlobeMatrix: true});
            expect(data.projectionTransition).toBe(0.5);
            expect(data.clippingPlane[0]).toBeCloseTo((90 - AZIMUTHAL_SOUTHERN_LIMIT_DEGREES) / 180 * Math.PI, 10);
            const dataNoGlobe = transform.getProjectionData({overscaledTileID: new OverscaledTileID(5, 0, 5, 16, 11), applyGlobeMatrix: false});
            expect(dataNoGlobe.projectionTransition).toBe(0);
        });

        test('mercator state behaves like the mercator transform', () => {
            const transform = createTransform(new LngLat(8.6, 48.2), 7);
            transform.setTransitionState(0);
            const mercator = new MercatorTransform();
            mercator.resize(640, 480);
            mercator.setZoom(7);
            mercator.setCenter(new LngLat(8.6, 48.2));
            for (const location of [new LngLat(8, 48), new LngLat(9.5, 49)]) {
                expectPointsClose(transform.locationToScreenPoint(location), mercator.locationToScreenPoint(location), 6);
            }
        });

        test('at the end of the transition the plane matches mercator around the center', () => {
            const plane = new AzimuthalEquidistantPlaneTransform();
            const mercator = new MercatorTransform();
            for (const tr of [plane, mercator]) {
                tr.resize(640, 480);
                tr.setZoom(12);
                tr.setCenter(new LngLat(8.63, 48.17));
            }
            plane.setAzimuthalness(0);
            plane.apply(plane, false);
            for (const location of [new LngLat(8.64, 48.17), new LngLat(8.63, 48.18), new LngLat(8.62, 48.16)]) {
                const a = plane.locationToScreenPoint(location);
                const b = mercator.locationToScreenPoint(location);
                expect(a.dist(b)).toBeLessThan(0.5);
            }
        });
    });

    describe('covering tiles', () => {
        test('tiles south of the outer ring are not loaded', () => {
            const transform = createTransform(new LngLat(0, 90), 0.5);
            const tiles = coveringTiles(transform, {tileSize: 64, minzoom: 3, maxzoom: 3});
            expect(tiles.length).toBeGreaterThan(0);
            for (const tile of tiles) {
                expect(tile.canonical.y).toBeLessThan(6);
            }
        });

        test('tiles outside of the screen are not loaded', () => {
            const transform = createTransform(new LngLat(8.6, 48.2), 5);
            const tiles = coveringTiles(transform, {tileSize: 512});
            expect(tiles.length).toBeGreaterThan(0);
            expect(tiles.length).toBeLessThan(12);
            expect(tiles.some(t => t.canonical.z === 5 && t.canonical.x === 16 && t.canonical.y === 11)).toBe(true);
        });

        test('bounding volume of tiles outside of the ring never intersects', () => {
            const provider = new AzimuthalEquidistantCoveringTilesDetailsProvider();
            const transform = createTransform(new LngLat(0, 90), 0.5);
            const volume = provider.getTileBoundingVolume({x: 0, y: 7, z: 3}, 0, 0, null);
            expect(volume.intersectsFrustum(transform.getCameraFrustum())).toBe(IntersectionResult.None);
        });
    });

    test('bounds of the UN view include the pole', () => {
        const transform = createTransform(new LngLat(0, 90), 1);
        const bounds = transform.getBounds();
        expect(bounds.getNorth()).toBe(90);
        expect(bounds.getWest()).toBe(-180);
        expect(bounds.getEast()).toBe(180);
        expect(bounds.getSouth()).toBeGreaterThanOrEqual(AZIMUTHAL_SOUTHERN_LIMIT_DEGREES);
    });

    test('clone keeps the state', () => {
        const transform = createTransform(new LngLat(20, 60), 3, 15);
        transform.setTransitionState(0.25);
        const clone = transform.clone();
        expectPointsClose(clone.locationToScreenPoint(new LngLat(25, 55)), transform.locationToScreenPoint(new LngLat(25, 55)));
    });
});

describe('AzimuthalEquidistantProjection', () => {
    test('azimuthalness of projection values', () => {
        expect(getAzimuthalness('azimuthal-equidistant')).toBe(1);
        expect(getAzimuthalness('mercator')).toBe(0);
        expect(getAzimuthalness(new ProjectionDefinition('azimuthal-equidistant', 'mercator', 0.25))).toBeCloseTo(0.75, 10);
        expect(getAzimuthalness(new ProjectionDefinition('mercator', 'azimuthal-equidistant', 0.25))).toBeCloseTo(0.25, 10);
        expect(getAzimuthalness(new ProjectionDefinition('azimuthal-equidistant', 'azimuthal-equidistant', 1))).toBe(1);
    });

    test('specifications using the projection are detected', () => {
        expect(isAzimuthalEquidistantSpecification('azimuthal-equidistant')).toBe(true);
        expect(isAzimuthalEquidistantSpecification(transitionExpression)).toBe(true);
        expect(isAzimuthalEquidistantSpecification('globe')).toBe(false);
        expect(isAzimuthalEquidistantSpecification(['interpolate', ['linear'], ['zoom'], 11, 'vertical-perspective', 12, 'mercator'])).toBe(false);
    });

    test('transition state follows the zoom expression', () => {
        const projection = new AzimuthalEquidistantProjection({type: transitionExpression as any}, {});
        expect(projection.getTransitionStateAtZoom(2)).toBe(1);
        expect(projection.getTransitionStateAtZoom(5.5)).toBeCloseTo(0.5, 10);
        expect(projection.getTransitionStateAtZoom(8)).toBe(0);
    });

    test('mercator shaders are used while the map shows mercator', () => {
        const projection = new AzimuthalEquidistantProjection({type: 'mercator'}, {});
        expect(projection.shaderVariantName).toBe('mercator');
        expect(projection.useSubdivision).toBe(false);
        const azimuthal = new AzimuthalEquidistantProjection({type: 'azimuthal-equidistant'}, {});
        expect(azimuthal.shaderVariantName).toBe('azimuthal');
        expect(azimuthal.shaderDefine).toContain('#define GLOBE');
        expect(azimuthal.useSubdivision).toBe(true);
    });

    test('factory creates the azimuthal projection for names and expressions', () => {
        expect(createProjectionFromName('azimuthal-equidistant', undefined, {}).projection).toBeInstanceOf(AzimuthalEquidistantProjection);
        expect(createProjectionFromName('azimuthal-equidistant', undefined, {}).transform).toBeInstanceOf(AzimuthalEquidistantTransform);
        expect(createProjectionFromName(transitionExpression as any, undefined, {}).projection).toBeInstanceOf(AzimuthalEquidistantProjection);
        expect(createProjectionFromName(['interpolate', ['linear'], ['zoom'], 11, 'vertical-perspective', 12, 'mercator'] as any, undefined, {}).projection).toBeInstanceOf(GlobeProjection);
    });
});

describe('AzimuthalEquidistantCameraHelper', () => {
    const projection = new AzimuthalEquidistantProjection({type: transitionExpression as any}, {});
    const helper = new AzimuthalEquidistantCameraHelper(projection);

    test('flyTo reaches the target center, zoom and bearing exactly', () => {
        const transform = createTransform(new LngLat(0, 90), 1);
        const target = new LngLat(8.63, 48.17);
        const flight = helper.handleFlyTo(transform, {
            bearing: 0,
            pitch: 0,
            roll: 0,
            padding: transform.padding,
            offsetAsPoint: new Point(0, 0),
            locationAtOffset: transform.center,
            center: target,
            zoom: 14,
        });
        expect(flight.pixelPathLength).toBeGreaterThan(0);
        // The camera derives the flight curve from it, also without a requested minimum zoom.
        expect(Number.isFinite(flight.scaleOfMinZoom)).toBe(true);
        expect(flight.scaleOfMinZoom).toBeLessThanOrEqual(1);
        flight.easeFunc(0.5, Math.pow(2, 2), 0.5, transform.centerPoint);
        expect(transform.center.lat).toBeLessThan(90);
        expect(transform.center.lat).toBeGreaterThan(48.17);
        flight.easeFunc(1, flight.scaleOfZoom, 1, transform.centerPoint);
        expect(transform.center.lng).toBeCloseTo(8.63, 8);
        expect(transform.center.lat).toBeCloseTo(48.17, 8);
        expect(transform.zoom).toBeCloseTo(14, 8);
        expect(transform.bearing).toBeCloseTo(0, 8);
    });

    test('flyTo turns the disk smoothly', () => {
        const transform = createTransform(new LngLat(0, 90), 1);
        const flight = helper.handleFlyTo(transform, {
            bearing: 0,
            pitch: 0,
            roll: 0,
            padding: transform.padding,
            offsetAsPoint: new Point(0, 0),
            locationAtOffset: transform.center,
            center: new LngLat(100, 40),
            zoom: 3,
        });
        flight.easeFunc(0.5, 1, 0.5, transform.centerPoint);
        // Halfway, the disk is turned by half of the target rotation (100° - 0°).
        expect(transform.center.lng - transform.bearing).toBeCloseTo(50, 6);
    });

    test('easeTo without a target center keeps the center', () => {
        const transform = createTransform(new LngLat(20, 70), 2);
        const ease = helper.handleEaseTo(transform, {
            bearing: 30,
            pitch: 0,
            roll: 0,
            padding: transform.padding,
            offsetAsPoint: new Point(0, 0),
            zoom: 3,
        });
        ease.easeFunc(1);
        expect(transform.center.lng).toBeCloseTo(20, 8);
        expect(transform.center.lat).toBeCloseTo(70, 8);
        expect(transform.bearing).toBeCloseTo(30, 8);
        expect(transform.zoom).toBeCloseTo(3, 8);
    });
});
