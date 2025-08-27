// SPDX-FileCopyrightText: 2025 夕月霞
// SPDX-License-Identifier: AGPL-3.0-or-later
// All coordinates are right-handed.
#include <emscripten.h>

#include <algorithm>
#include <cassert>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>
#include <vector>

#include "manifold/cross_section.h"
#include "manifold/manifold.h"

// clang-format off
EM_JS(void, wasmLog, (const char* msg), {
  console.log("WASM:", UTF8ToString(msg));
})

EM_JS(void, wasmBeginPerf, (const char* tag), {
  if (!Module.perfMap) {
    Module.perfMap = new Map();
  }
  const tagJs = UTF8ToString(tag);
  Module.perfMap.set(tagJs, performance.now());
})

EM_JS(void, wasmEndPerf, (const char* tag), {
  const tEnd = performance.now();
  const tagJs = UTF8ToString(tag);
  const tBegin = Module.perfMap && Module.perfMap.get(tagJs);
  if (tBegin === undefined) {
    console.warn(`${tagJs}: missing wasmBeginPerf`);
  } else {
    console.log(`${tagJs}: ${tEnd - tBegin}ms`);
    Module.perfMap.delete(tagJs);
  }
})
// clang-format on

static void wasmLog(const std::string& msg) {
  wasmLog(msg.c_str());
}

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
} contours;

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

// Convert Manifold Polygons to contours struct
static contours* polygons_to_contours(const manifold::Polygons& polygons) {
  auto* result = static_cast<contours*>(malloc(sizeof(contours)));
  result->num_contours = polygons.size();

  if (polygons.empty()) {
    result->contours = nullptr;
    return result;
  }

  result->contours =
      static_cast<contour_2d*>(malloc(sizeof(contour_2d) * polygons.size()));

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

  return result;
}

// Extract outermost cross section.
static manifold::CrossSection extract_outermost(
    const manifold::CrossSection cs) {
  auto parts = cs.Decompose();
  std::vector<manifold::CrossSection> parts_outer;
  for (auto& part : parts) {
    auto polys = part.ToPolygons();
    int num_contours = polys.size();
    assert(num_contours > 0);
    if (num_contours == 1) {
      // if num_contours == 1 (no holes), the one is also the outermost.
      parts_outer.push_back(part);
    } else {
      // find contour with max area (holes (CW contour) will have 0 area)
      double max_a = -1;
      size_t max_i = 0;
      for (size_t i = 0; i < polys.size(); i++) {
        double a = manifold::CrossSection(polys[i]).Area();
        if (a > max_a) {
          max_a = a;
          max_i = i;
        }
      }
      parts_outer.push_back(manifold::CrossSection(polys[max_i]));
    }
  }
  return manifold::CrossSection::Compose(parts_outer);
}

// Exported functions
extern "C" {

// Project 3D manifold onto a plane defined by view_dir_z and origin.
// Returns contours projected onto the view plane.
//
// Caller must free the returned data.
EMSCRIPTEN_KEEPALIVE
contours* project_manifold(const manifold::Manifold* manifold_ptr,
                           const vector3* origin,
                           const vector3* view_x,
                           const vector3* view_y,
                           const vector3* view_dir_z,
                           double offset,
                           bool only_outermost) {
  assert(manifold_ptr != nullptr);

  const manifold::Manifold& mesh = *manifold_ptr;

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

  projection =
      projection.Offset(offset, manifold::CrossSection::JoinType::Square);
  if (only_outermost) {
    projection = extract_outermost(projection);
  }
  return polygons_to_contours(projection.ToPolygons());
}

// Perform boolean subtraction using Manifold: A - B, returns new Manifold
EMSCRIPTEN_KEEPALIVE
manifold::Manifold* subtract_manifolds(const manifold::Manifold* manifold_a,
                                       const manifold::Manifold* manifold_b) {
  assert(manifold_a != nullptr);
  assert(manifold_b != nullptr);

  // Perform boolean subtraction
  auto* result = new manifold::Manifold(*manifold_a - *manifold_b);
  if (result->Status() != manifold::Manifold::Error::NoError) {
    wasmLog("subtract_manifolds: resulted in failed status " +
            std::to_string(static_cast<int>(result->Status())));
    delete result;
    return nullptr;
  }

  // TODO: is this check necessary?
  if (result->IsEmpty()) {
    wasmLog("Boolean subtraction produced empty result");
    delete result;
    return nullptr;
  }

  return result;
}

// Perform boolean intersection using Manifold: A ∩ B, returns new Manifold
EMSCRIPTEN_KEEPALIVE
manifold::Manifold* intersect_manifolds(const manifold::Manifold* manifold_a,
                                        const manifold::Manifold* manifold_b) {
  assert(manifold_a != nullptr);
  assert(manifold_b != nullptr);

  // Perform boolean intersection
  auto* result = new manifold::Manifold(*manifold_a ^ *manifold_b);
  if (result->Status() != manifold::Manifold::Error::NoError) {
    wasmLog("intersect_manifolds: resulted in failed status " +
            std::to_string(static_cast<int>(result->Status())));
    delete result;
    return nullptr;
  }

  // TODO: is this check necessary?
  if (result->IsEmpty()) {
    wasmLog("Boolean intersection produced empty result");
    delete result;
    return nullptr;
  }

  return result;
}

// Returns Manifold instance if succesful, otherwise nullptr.
// Must be destroyed by caller w/ destroy_manifold.
EMSCRIPTEN_KEEPALIVE
manifold::Manifold* create_manifold_from_trisoup(const triangle_soup* soup) {
  manifold::MeshGL meshgl = soup_to_manifold_meshgl(soup);
  auto* manifold = new manifold::Manifold(meshgl);

  if (manifold->Status() != manifold::Manifold::Error::NoError) {
    wasmLog("Failed to create manifold");
    delete manifold;
    return nullptr;
  }

  return manifold;
}

EMSCRIPTEN_KEEPALIVE
void destroy_manifold(manifold::Manifold* manifold_ptr) {
  delete manifold_ptr;
}

// Convert Manifold to triangle soup
EMSCRIPTEN_KEEPALIVE
triangle_soup* manifold_to_trisoup(const manifold::Manifold* manifold_ptr) {
  assert(manifold_ptr != nullptr);

  manifold::MeshGL meshgl = manifold_ptr->GetMeshGL();

  const size_t num_tris = meshgl.triVerts.size() / 3;
  const size_t num_verts = num_tris * 3;

  auto* result = static_cast<triangle_soup*>(malloc(sizeof(triangle_soup)));
  result->num_vertices = num_verts;

  if (num_verts > 0) {
    result->vertices =
        static_cast<vector3*>(malloc(sizeof(vector3) * num_verts));

    size_t idx = 0;
    for (size_t t = 0; t < num_tris; t++) {
      for (int v = 0; v < 3; v++) {
        uint32_t vertIdx = meshgl.triVerts[t * 3 + v];
        // Extract position from vertProperties (first 3 properties are x,y,z)
        result->vertices[idx].x =
            meshgl.vertProperties[vertIdx * meshgl.numProp];
        result->vertices[idx].y =
            meshgl.vertProperties[vertIdx * meshgl.numProp + 1];
        result->vertices[idx].z =
            meshgl.vertProperties[vertIdx * meshgl.numProp + 2];
        idx++;
      }
    }
  } else {
    result->vertices = nullptr;
  }

  return result;
}

EMSCRIPTEN_KEEPALIVE
void free_triangle_soup(triangle_soup* result) {
  if (result == nullptr) {
    return;
  }

  free(result->vertices);
  free(result);
}

EMSCRIPTEN_KEEPALIVE
void free_contours(contours* result) {
  if (result == nullptr) {
    return;
  }

  if (result->contours) {
    for (int i = 0; i < result->num_contours; i++) {
      free(result->contours[i].points);
    }
    free(result->contours);
  }
  free(result);
}
}
