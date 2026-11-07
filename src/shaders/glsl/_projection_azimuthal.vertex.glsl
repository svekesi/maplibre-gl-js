// Azimuthal equidistant projection centered on the north pole (the map of the United Nations emblem).
// This prelude implements the same functions as the globe prelude, so that all `#ifdef GLOBE` code paths of the
// layer shaders work with it. Instead of a position on the unit sphere, `projectToSphere` returns a position
// in the azimuthal plane, measured in earth radii: x = c * sin(lng), y = c * cos(lng), where c is the colatitude.

#define GLOBE_RADIUS 6371008.8

// Custom layers get this prelude without _prelude.vertex.glsl, which defines PROJECTION_UBO, so they set these as plain uniforms.
// Azimuthal projection: x of the clipping plane holds the colatitude of the outer ring of the map in radians. Everything beyond it is clipped.
#ifndef PROJECTION_UBO
uniform highp vec4 u_projection_tile_mercator_coords;
uniform highp vec4 u_projection_clipping_plane;
uniform highp float u_projection_transition;
uniform mat4 u_projection_fallback_matrix;
#endif

// The in-tile X coordinate of the projected vertex, used by clipAntimeridian() in the fragment shader (see _projection_globe.fragment.glsl).
out highp float v_projection_tile_x;

float azimuthalColatitude(float mercatorY) {
    return 2.0 * atan(exp(PI * (2.0 * mercatorY - 1.0)));
}

// Unit vector towards east at the given plane position.
vec3 azimuthalEast(vec3 planePos) {
    float c = length(planePos.xy);
    if (c < 1e-7) {
        return vec3(1.0, 0.0, 0.0);
    }
    return vec3(planePos.y, -planePos.x, 0.0) / c;
}

// Unit vector pointing away from the pole (towards south) at the given plane position.
vec3 azimuthalSouth(vec3 planePos) {
    float c = length(planePos.xy);
    if (c < 1e-7) {
        return vec3(0.0, 1.0, 0.0);
    }
    return vec3(planePos.xy / c, 0.0);
}

// Offsets a plane position by small angles on the sphere: x towards east, y towards south.
// The parallels are stretched by c / sin(c) in this projection, the meridians are true to scale.
vec3 globeRotateVector(vec3 vec, vec2 angles) {
    float c = length(vec.xy);
    float stretch = c < 1e-4 ? 1.0 : c / sin(c);
    return vec + azimuthalEast(vec) * angles.x * stretch + azimuthalSouth(vec) * angles.y;
}

// Rotates tile space vectors (x east, y south, z up) into the plane.
mat3 globeGetRotationMatrix(vec3 planePos) {
    return mat3(
        azimuthalEast(planePos),
        azimuthalSouth(planePos),
        vec3(0.0, 0.0, 1.0)
    );
}

// Ratio of plane scale to mercator scale at the given tile Y, geometric mean of north-south and east-west.
// Consider this private, do not use in other shaders directly!
// Use `projectLineThickness` or `projectCircleRadius` instead.
float circumferenceRatioAtTileY(float tileY) {
    float mercator_pos_y = u_projection_tile_mercator_coords.y + u_projection_tile_mercator_coords.w * tileY;
    float c = azimuthalColatitude(mercator_pos_y);
    return max(sqrt(c * sin(c)), 1e-4);
}

// Scale of the line extrusion in tile units, separately for tile X (east-west) and Y (north-south).
// A tile unit towards east covers c in the plane, towards south sin(c), relative to the mercator scale at the equator.
// Compensating both keeps lines equally wide in every direction, although the projection is not conformal.
vec2 projectLineThickness(float tileY) {
    float mercator_pos_y = u_projection_tile_mercator_coords.y + u_projection_tile_mercator_coords.w * tileY;
    float c = azimuthalColatitude(mercator_pos_y);
    vec2 thickness = 1.0 / max(vec2(c, sin(c)), vec2(1e-4));
    if (u_projection_transition < 0.999) {
        return mix(vec2(1.0), thickness, u_projection_transition);
    } else {
        return thickness;
    }
}

// Get position inside the tile in range 0..8192 and project it onto the azimuthal plane.
// Additionally project special Y values to the poles.
// - translatedPos: tile-space vertex position, optionally with user-specified translation already applied
// - rawPos: the original tile-space vertex position *without translation* - needed because we would not be able to detect pole vertices from coordinates modified by translation.
vec3 projectToSphere(vec2 translatedPos, vec2 rawPos) {
    vec2 mercator_pos = u_projection_tile_mercator_coords.xy + u_projection_tile_mercator_coords.zw * translatedPos;
    float lng = mercator_pos.x * PI * 2.0 - PI;
    float c = azimuthalColatitude(mercator_pos.y);

    // North pole
    if (rawPos.y < -32767.5) {
        c = 0.0;
    }
    // South pole
    if (rawPos.y > 32766.5) {
        c = PI;
    }

    return vec3(c * sin(lng), c * cos(lng), 0.0);
}

vec3 projectToSphere(vec2 posInTile) {
    return projectToSphere(posInTile, vec2(0.0, 0.0));
}

// Depth value in range 0..1 for everything inside the outer ring, larger than 1 outside of it.
// Geometry beyond the ring is thus removed by the hardware depth clipping.
float azimuthalClippingZ(vec3 planePos) {
    return length(planePos.xy) / u_projection_clipping_plane.x;
}

vec4 interpolateProjection(vec2 posInTile, vec3 planePos, float elevation) {
    v_projection_tile_x = posInTile.x;
    vec4 azimuthalPosition = u_projection_matrix * vec4(planePos.xy, elevation / GLOBE_RADIUS, 1.0);
    // Z is overwritten by glDepthRange anyway - use a custom z value to clip geometry beyond the outer ring.
    azimuthalPosition.z = azimuthalClippingZ(planePos) * azimuthalPosition.w;

    if (u_projection_transition > 0.999) {
        return azimuthalPosition;
    }

    // Blend between azimuthal and mercator projections.
    vec4 flatPosition = u_projection_fallback_matrix * vec4(posInTile, elevation, 1.0);
    // Only interpolate to azimuthal Z for the last 80% of the animation.
    const float z_azimuthalness_threshold = 0.2;
    vec4 result = azimuthalPosition;
    result.z = mix(0.0, azimuthalPosition.z, clamp((u_projection_transition - z_azimuthalness_threshold) / (1.0 - z_azimuthalness_threshold), 0.0, 1.0));
    result.xyw = mix(flatPosition.xyw, azimuthalPosition.xyw, u_projection_transition);
    // Gradually hide poles during transition
    if ((posInTile.y < -32767.5) || (posInTile.y > 32766.5)) {
        result = azimuthalPosition;
        const float poles_hidden_anim_percentage = 0.02; // Only draw poles in the last 2% of the animation.
        result.z = mix(azimuthalPosition.z, 100.0, pow(max((1.0 - u_projection_transition) / poles_hidden_anim_percentage, 0.0), 8.0));
    }
    return result;
}

// Unlike interpolateProjection, this variant of the function preserves the Z value of the final vector.
vec4 interpolateProjectionFor3D(vec2 posInTile, vec3 planePos, float elevation) {
    v_projection_tile_x = posInTile.x;
    vec4 azimuthalPosition = u_projection_matrix * vec4(planePos.xy, elevation / GLOBE_RADIUS, 1.0);

    if (u_projection_transition > 0.999) {
        return azimuthalPosition;
    }

    // Blend between azimuthal and mercator projections.
    vec4 fallbackPosition = u_projection_fallback_matrix * vec4(posInTile, elevation, 1.0);
    return mix(fallbackPosition, azimuthalPosition, u_projection_transition);
}

// Computes screenspace projection
// and **replaces Z** with a custom value that clips geometry
// beyond the outer ring of the map.
vec4 projectTile(vec2 posInTile) {
    return interpolateProjection(posInTile, projectToSphere(posInTile), 0.0);
}

// A variant that supports special pole vertices.
vec4 projectTile(vec2 posInTile, vec2 rawPos) {
    return interpolateProjection(posInTile, projectToSphere(posInTile, rawPos), 0.0);
}

// Uses elevation to compute final screenspace projection
// and **replaces Z** with a custom value that clips geometry
// beyond the outer ring of the map.
vec4 projectTileWithElevation(vec2 posInTile, float elevation) {
    return interpolateProjection(posInTile, projectToSphere(posInTile), elevation);
}

// Projects the tile coordinates+elevation while **preserving Z** value from multiplication with the projection matrix.
// Applies pole vertices.
vec4 projectTileFor3D(vec2 posInTile, float elevation) {
    vec3 planePos = projectToSphere(posInTile, posInTile);
    return interpolateProjectionFor3D(posInTile, planePos, elevation);
}
