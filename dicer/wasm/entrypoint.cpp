// SPDX-FileCopyrightText: 2025 夕月霞
// SPDX-License-Identifier: AGPL-3.0-or-later
// All coordinates are right-handed.
#include <emscripten.h>

#include <algorithm>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>
#include <vector>

#include "manifold/cross_section.h"
#include "manifold/manifold.h"

EM_JS(void, wasmLog, (const char* msg), {
  console.log("WASM:", UTF8ToString(msg));
});

EM_JS(void, wasmBeginPerf, (const char* tag), {
  if (!Module.perfMap) {
    Module.perfMap = new Map();
  }
  const tagJs = UTF8ToString(tag);
  Module.perfMap.set(tagJs, performance.now());
});

EM_JS(void, wasmEndPerf, (const char* tag), {
  const tEnd = performance.now();
  const tagJs = UTF8ToString(tag);
  const tBegin = Module.perfMap && Module.perfMap.get(tagJs);
  if (tBegin === undefined) {
    console.warn("wasmEndPerf: no matching wasmBeginPerf for " + tagJs);
  } else {
    const t = tEnd - tBegin;
    console.log(`${UTF8ToString(tag)}: ${t}ms`);
    Module.perfMap.delete(tagJs);
  }
});

typedef struct {
  float x;
  float y;
} vector2;

typedef struct {
  float x;
  float y;
  float z;
} vector3;

// Triangle soup with no holes or self-intersections.
typedef struct {
  int num_vertices;
  vector3* vertices;
} triangle_soup;

// A single contour (closed loop of 2D points)
typedef struct {
  int num_points;
  vector2* points;
} contour_2d;

// Collection of 2D contours
typedef struct {
  int num_contours;
  contour_2d* contours;
  char* error_message;  // null on success
} contours_result;

// Result from mesh operations (contains triangle soup or error)
typedef struct {
  int num_vertices;
  float* vertices;      // flattened vertex data (x,y,z per vertex)
  char* error_message;  // null on success
} triangle_soup_result;

// Forward declaration
static manifold::MeshGL soup_to_manifold_meshgl(const triangle_soup* soup);

// Utility function to create error result
static contours_result* error_result(const std::string& msg) {
  auto* result = static_cast<contours_result*>(malloc(sizeof(contours_result)));
  result->num_contours = 0;
  result->contours = nullptr;
  result->error_message = static_cast<char*>(malloc(msg.size() + 1));
  strcpy(result->error_message, msg.c_str());
  return result;
}

// Project 3D mesh onto a plane defined by view_dir_z and origin.
// Returns contours projected onto the view plane.
//
// Caller must free the returned data.
extern "C" contours_result* project_mesh(const triangle_soup* soup,
                                         const vector3* origin,
                                         const vector3* view_x,
                                         const vector3* view_y,
                                         const vector3* view_dir_z) {
  try {
    wasmBeginPerf("mesh conversion");
    // Convert triangle soup to Manifold
    manifold::MeshGL meshgl = soup_to_manifold_meshgl(soup);
    if (meshgl.vertProperties.empty()) {
      return error_result("Invalid triangle soup");
    }

    manifold::Manifold mesh(meshgl);
    if (mesh.Status() != manifold::Manifold::Error::NoError) {
      return error_result("Failed to create valid manifold - " +
                          std::to_string(static_cast<int>(mesh.Status())));
    }
    wasmEndPerf("mesh conversion");

    // mesh.SetTolerance(1e-3); // 1um

    // Build transformation matrix to align view_dir_z with Z axis
    // The projection plane will be the XY plane after transformation
    manifold::vec3 orig(origin->x, origin->y, origin->z);
    manifold::vec3 vx(view_x->x, view_x->y, view_x->z);
    manifold::vec3 vy(view_y->x, view_y->y, view_y->z);
    manifold::vec3 vz(view_dir_z->x, view_dir_z->y, view_dir_z->z);

    // Create transformation matrix: columns are the new basis vectors
    // This transforms from world space to view space (column-major order)
    manifold::mat3x4 transform(
        manifold::vec3(vx.x, vy.x, vz.x),  // First column (X basis)
        manifold::vec3(vx.y, vy.y, vz.y),  // Second column (Y basis)
        manifold::vec3(vx.z, vy.z, vz.z),  // Third column (Z basis)
        manifold::vec3(-linalg::dot(vx, orig), -linalg::dot(vy, orig),
                       -linalg::dot(vz, orig))  // Fourth column (translation)
    );

    // Apply transformation to the manifold
    manifold::Manifold transformed = mesh.Transform(transform);

    // Project onto XY plane (Z=0) to get 2D cross-section
    manifold::CrossSection projection = transformed.Project();

    // Offset the projection by 1.5 units with square join type
    projection =
        projection.Offset(1.5, manifold::CrossSection::JoinType::Square);

    // Convert to polygons
    manifold::Polygons polygons = projection.ToPolygons();

    // Create result
    auto* result =
        static_cast<contours_result*>(malloc(sizeof(contours_result)));
    result->num_contours = polygons.size();
    result->error_message = nullptr;

    if (!polygons.empty()) {
      result->contours = static_cast<contour_2d*>(
          malloc(sizeof(contour_2d) * polygons.size()));

      // Convert each polygon to a contour
      for (size_t i = 0; i < polygons.size(); i++) {
        const auto& polygon = polygons[i];
        result->contours[i].num_points = polygon.size();

        if (polygon.size() > 0) {
          result->contours[i].points =
              static_cast<vector2*>(malloc(sizeof(vector2) * polygon.size()));
          for (size_t j = 0; j < polygon.size(); j++) {
            result->contours[i].points[j].x = static_cast<float>(polygon[j].x);
            result->contours[i].points[j].y = static_cast<float>(polygon[j].y);
          }
        } else {
          result->contours[i].points = nullptr;
        }
      }
    } else {
      result->contours = nullptr;
    }
    return result;
  } catch (const std::exception& e) {
    return error_result(std::string("Exception: ") + e.what());
  } catch (...) {
    return error_result("Unknown exception during mesh projection");
  }
}

// Helper function to free contours memory
extern "C" void free_contours(contours_result* result) {
  if (!result)
    return;

  if (result->contours) {
    for (int i = 0; i < result->num_contours; i++) {
      free(result->contours[i].points);
    }
    free(result->contours);
  }
  free(result->error_message);
  free(result);
}

// Helper to create triangle soup result with error
static triangle_soup_result* error_soup_result(const std::string& msg) {
  auto* result =
      static_cast<triangle_soup_result*>(malloc(sizeof(triangle_soup_result)));
  result->num_vertices = 0;
  result->vertices = nullptr;
  result->error_message = static_cast<char*>(malloc(msg.size() + 1));
  strcpy(result->error_message, msg.c_str());
  return result;
}

// Helper function to free triangle soup result memory
extern "C" void free_triangle_soup_result(triangle_soup_result* result) {
  if (!result)
    return;

  free(result->vertices);
  free(result->error_message);
  free(result);
}

// Convert triangle soup to Manifold MeshGL and merge duplicates
static manifold::MeshGL soup_to_manifold_meshgl(const triangle_soup* soup) {
  manifold::MeshGL meshgl;

  if (!soup || !soup->vertices || soup->num_vertices <= 0 ||
      soup->num_vertices % 3 != 0) {
    return meshgl;
  }

  const int num_tris = soup->num_vertices / 3;
  const int total_verts = soup->num_vertices;

  // Prepare vertex properties (x, y, z for each vertex)
  meshgl.numProp = 3;
  meshgl.vertProperties.reserve(total_verts * 3);

  for (int i = 0; i < total_verts; i++) {
    meshgl.vertProperties.push_back(soup->vertices[i].x);
    meshgl.vertProperties.push_back(soup->vertices[i].y);
    meshgl.vertProperties.push_back(soup->vertices[i].z);
  }

  // Prepare triangle indices (direct mapping for now)
  meshgl.triVerts.reserve(num_tris * 3);

  for (int t = 0; t < num_tris; t++) {
    meshgl.triVerts.push_back(t * 3);
    meshgl.triVerts.push_back(t * 3 + 1);
    meshgl.triVerts.push_back(t * 3 + 2);
  }

  // Merge duplicate vertices - this is critical for valid manifold creation
  meshgl.Merge();

  return meshgl;
}

// Convert Manifold MeshGL back to triangle soup result
static triangle_soup_result* manifold_meshgl_to_soup(
    const manifold::MeshGL& meshgl) {
  auto* result =
      static_cast<triangle_soup_result*>(malloc(sizeof(triangle_soup_result)));

  const size_t num_tris = meshgl.triVerts.size() / 3;
  const size_t num_verts = num_tris * 3;

  result->num_vertices = num_verts;
  result->error_message = nullptr;

  if (num_verts > 0) {
    result->vertices =
        static_cast<float*>(malloc(sizeof(float) * num_verts * 3));

    size_t idx = 0;
    for (size_t t = 0; t < num_tris; t++) {
      for (int v = 0; v < 3; v++) {
        uint32_t vertIdx = meshgl.triVerts[t * 3 + v];
        // Extract position from vertProperties (first 3 properties are x,y,z)
        result->vertices[idx++] =
            meshgl.vertProperties[vertIdx * meshgl.numProp];
        result->vertices[idx++] =
            meshgl.vertProperties[vertIdx * meshgl.numProp + 1];
        result->vertices[idx++] =
            meshgl.vertProperties[vertIdx * meshgl.numProp + 2];
      }
    }
  } else {
    result->vertices = nullptr;
  }

  return result;
}

// Perform boolean subtraction using Manifold: A - B
extern "C" triangle_soup_result* manifold_subtract_meshes(
    const triangle_soup* soup_a,
    const triangle_soup* soup_b) {
  try {
    // Convert soups to Manifold MeshGL with vertex merging
    manifold::MeshGL meshgl_a = soup_to_manifold_meshgl(soup_a);
    if (meshgl_a.vertProperties.empty()) {
      return error_soup_result("mesh_a: invalid triangle soup");
    }

    manifold::MeshGL meshgl_b = soup_to_manifold_meshgl(soup_b);
    if (meshgl_b.vertProperties.empty()) {
      return error_soup_result("mesh_b: invalid triangle soup");
    }

    // Create Manifolds from MeshGL
    manifold::Manifold manifold_a(meshgl_a);
    if (manifold_a.Status() != manifold::Manifold::Error::NoError) {
      return error_soup_result(
          "mesh_a: failed to create valid manifold - " +
          std::to_string(static_cast<int>(manifold_a.Status())));
    }

    manifold::Manifold manifold_b(meshgl_b);
    if (manifold_b.Status() != manifold::Manifold::Error::NoError) {
      return error_soup_result(
          "mesh_b: failed to create valid manifold - " +
          std::to_string(static_cast<int>(manifold_b.Status())));
    }

    // Perform boolean subtraction
    manifold::Manifold result = manifold_a - manifold_b;
    if (result.Status() != manifold::Manifold::Error::NoError) {
      return error_soup_result(
          "Boolean subtraction failed - " +
          std::to_string(static_cast<int>(result.Status())));
    }
    if (result.IsEmpty()) {
      return error_soup_result("Boolean subtraction produced empty result");
    }

    manifold::MeshGL result_meshgl = result.GetMeshGL();
    return manifold_meshgl_to_soup(result_meshgl);
  } catch (const std::exception& e) {
    return error_soup_result(std::string("Exception: ") + e.what());
  } catch (...) {
    return error_soup_result(
        "Unknown exception during Manifold mesh subtraction");
  }
}
