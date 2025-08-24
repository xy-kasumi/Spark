// All coordinates are right-handed.

#include <algorithm>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>
#include <vector>

#include "cross_section.h"
#include "glm/glm.hpp"
#include "glm/gtc/matrix_transform.hpp"
#include "manifold.h"

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

// A single 2D line segment
typedef struct {
  vector2 start;
  vector2 end;
} edge_2d;

// Collection of 2D edges (edge soup)
typedef struct {
  int num_edges;
  edge_2d* edges;
  char* error_message;  // null on success
} edge_soup;

// Result from mesh operations (contains triangle soup or error)
typedef struct {
  int num_vertices;
  float* vertices;      // flattened vertex data (x,y,z per vertex)
  char* error_message;  // null on success
} triangle_soup_result;

// Forward declaration
static manifold::MeshGL soup_to_manifold_meshgl(const triangle_soup* soup);

// Utility function to create error result
static edge_soup* error_result(const std::string& msg) {
  auto* result = static_cast<edge_soup*>(malloc(sizeof(edge_soup)));
  result->num_edges = 0;
  result->edges = nullptr;
  result->error_message = static_cast<char*>(malloc(msg.size() + 1));
  strcpy(result->error_message, msg.c_str());
  return result;
}

// Project 3D mesh onto a plane defined by view_dir_z and origin.
// Returns silhouette edges projected onto the view plane.
//
// Caller must free the returned data.
extern "C" edge_soup* project_mesh(const triangle_soup* soup,
                                   const vector3* origin,
                                   const vector3* view_x,
                                   const vector3* view_y,
                                   const vector3* view_dir_z) {
  try {
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

    // Build transformation matrix to align view_dir_z with Z axis
    // The projection plane will be the XY plane after transformation
    glm::vec3 orig(origin->x, origin->y, origin->z);
    glm::vec3 vx(view_x->x, view_x->y, view_x->z);
    glm::vec3 vy(view_y->x, view_y->y, view_y->z);
    glm::vec3 vz(view_dir_z->x, view_dir_z->y, view_dir_z->z);

    // Create transformation matrix: columns are the new basis vectors
    // This transforms from world space to view space
    glm::mat4x3 transform(vx.x, vy.x, vz.x,  // First column (maps to X)
                          vx.y, vy.y, vz.y,  // Second column (maps to Y)
                          vx.z, vy.z, vz.z,  // Third column (maps to Z)
                          -glm::dot(vx, orig), -glm::dot(vy, orig),
                          -glm::dot(vz, orig)  // Translation
    );

    // Apply transformation to the manifold
    manifold::Manifold transformed = mesh.Transform(transform);

    // Project onto XY plane (Z=0) to get 2D cross-section
    manifold::CrossSection projection = transformed.Project();

    // Convert to polygons
    manifold::Polygons polygons = projection.ToPolygons();

    // Extract edges from polygons
    std::vector<edge_2d> edges;
    for (const auto& polygon : polygons) {
      size_t n = polygon.size();
      for (size_t i = 0; i < n; i++) {
        size_t j = (i + 1) % n;
        edge_2d edge;
        edge.start.x = static_cast<float>(polygon[i].x);
        edge.start.y = static_cast<float>(polygon[i].y);
        edge.end.x = static_cast<float>(polygon[j].x);
        edge.end.y = static_cast<float>(polygon[j].y);
        edges.push_back(edge);
      }
    }

    // Create result
    auto* result = static_cast<edge_soup*>(malloc(sizeof(edge_soup)));
    result->num_edges = edges.size();
    result->error_message = nullptr;

    if (!edges.empty()) {
      result->edges =
          static_cast<edge_2d*>(malloc(sizeof(edge_2d) * edges.size()));
      std::memcpy(result->edges, edges.data(), sizeof(edge_2d) * edges.size());
    } else {
      result->edges = nullptr;
    }

    return result;

  } catch (const std::exception& e) {
    return error_result(std::string("Exception: ") + e.what());
  } catch (...) {
    return error_result("Unknown exception during mesh projection");
  }
}

// Helper function to free edge soup memory
extern "C" void free_edge_soup(edge_soup* soup) {
  if (!soup)
    return;

  free(soup->edges);
  free(soup->error_message);
  free(soup);
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

    // Get result as MeshGL
    manifold::MeshGL result_meshgl = result.GetMeshGL();

    // Convert back to triangle soup
    return manifold_meshgl_to_soup(result_meshgl);

  } catch (const std::exception& e) {
    return error_soup_result(std::string("Exception: ") + e.what());
  } catch (...) {
    return error_soup_result(
        "Unknown exception during Manifold mesh subtraction");
  }
}
