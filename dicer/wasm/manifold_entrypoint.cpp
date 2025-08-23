// Manifold-based geometric operations for WASM

#include <algorithm>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>
#include <vector>
#include <memory>

#include "manifold/include/manifold.h"

using namespace manifold;

// Data structures matching the JS side
typedef struct {
  float x;
  float y;
} vector2;

typedef struct {
  float x;
  float y;
  float z;
} vector3;

// Triangle soup with no holes or self-intersections
typedef struct {
  int num_vertices;
  vector3* vertices;
} triangle_soup;

// Result from mesh operations (contains triangle soup or error)
typedef struct {
  int num_vertices;
  float* vertices;      // flattened vertex data (x,y,z per vertex)
  char* error_message;  // null on success
} triangle_soup_result;

// Helper to create error result
static triangle_soup_result* error_soup_result(const std::string& msg) {
  auto* result = static_cast<triangle_soup_result*>(malloc(sizeof(triangle_soup_result)));
  result->num_vertices = 0;
  result->vertices = nullptr;
  result->error_message = static_cast<char*>(malloc(msg.size() + 1));
  strcpy(result->error_message, msg.c_str());
  return result;
}

// Convert triangle soup to Manifold Mesh
static Mesh soup_to_manifold_mesh(const triangle_soup* soup) {
  if (!soup || !soup->vertices || soup->num_vertices <= 0 || soup->num_vertices % 3 != 0) {
    return Mesh();
  }

  const int num_tris = soup->num_vertices / 3;
  const int total_verts = soup->num_vertices;
  
  // Prepare vertex data
  std::vector<glm::vec3> vertPos;
  vertPos.reserve(total_verts);
  
  for (int i = 0; i < total_verts; i++) {
    vertPos.push_back(glm::vec3(soup->vertices[i].x, soup->vertices[i].y, soup->vertices[i].z));
  }
  
  // Prepare triangle indices (direct mapping since soup is already triangulated)
  std::vector<glm::ivec3> triVerts;
  triVerts.reserve(num_tris);
  
  for (int t = 0; t < num_tris; t++) {
    triVerts.push_back(glm::ivec3(t * 3, t * 3 + 1, t * 3 + 2));
  }
  
  return Mesh{vertPos, triVerts};
}

// Convert Manifold Mesh back to triangle soup result
static triangle_soup_result* manifold_mesh_to_soup(const Mesh& mesh) {
  auto* result = static_cast<triangle_soup_result*>(malloc(sizeof(triangle_soup_result)));
  
  const size_t num_tris = mesh.triVerts.size();
  const size_t num_verts = num_tris * 3;
  
  result->num_vertices = num_verts;
  result->error_message = nullptr;
  
  if (num_verts > 0) {
    result->vertices = static_cast<float*>(malloc(sizeof(float) * num_verts * 3));
    
    size_t idx = 0;
    for (size_t t = 0; t < num_tris; t++) {
      const auto& tri = mesh.triVerts[t];
      for (int v = 0; v < 3; v++) {
        const auto& pos = mesh.vertPos[tri[v]];
        result->vertices[idx++] = pos.x;
        result->vertices[idx++] = pos.y;
        result->vertices[idx++] = pos.z;
      }
    }
  } else {
    result->vertices = nullptr;
  }
  
  return result;
}

// Perform boolean subtraction: A - B
extern "C" triangle_soup_result* manifold_subtract_meshes(const triangle_soup* soup_a, const triangle_soup* soup_b) {
  try {
    // Convert soups to Manifold meshes
    Mesh mesh_a = soup_to_manifold_mesh(soup_a);
    if (mesh_a.vertPos.empty()) {
      return error_soup_result("mesh_a: invalid triangle soup");
    }
    
    Mesh mesh_b = soup_to_manifold_mesh(soup_b);
    if (mesh_b.vertPos.empty()) {
      return error_soup_result("mesh_b: invalid triangle soup");
    }
    
    // Create Manifolds from meshes
    Manifold manifold_a(mesh_a);
    if (manifold_a.Status() != Manifold::Error::NoError) {
      return error_soup_result("mesh_a: failed to create valid manifold - " + std::to_string(static_cast<int>(manifold_a.Status())));
    }
    
    Manifold manifold_b(mesh_b);
    if (manifold_b.Status() != Manifold::Error::NoError) {
      return error_soup_result("mesh_b: failed to create valid manifold - " + std::to_string(static_cast<int>(manifold_b.Status())));
    }
    
    // Perform boolean subtraction
    Manifold result = manifold_a - manifold_b;
    
    if (result.Status() != Manifold::Error::NoError) {
      return error_soup_result("Boolean subtraction failed - " + std::to_string(static_cast<int>(result.Status())));
    }
    
    if (result.IsEmpty()) {
      return error_soup_result("Boolean subtraction produced empty result");
    }
    
    // Get result mesh
    Mesh result_mesh = result.GetMesh();
    
    // Convert back to triangle soup
    return manifold_mesh_to_soup(result_mesh);
    
  } catch (const std::exception& e) {
    return error_soup_result(std::string("Exception: ") + e.what());
  } catch (...) {
    return error_soup_result("Unknown exception during mesh subtraction");
  }
}

// Perform boolean union: A + B
extern "C" triangle_soup_result* manifold_union_meshes(const triangle_soup* soup_a, const triangle_soup* soup_b) {
  try {
    // Convert soups to Manifold meshes
    Mesh mesh_a = soup_to_manifold_mesh(soup_a);
    if (mesh_a.vertPos.empty()) {
      return error_soup_result("mesh_a: invalid triangle soup");
    }
    
    Mesh mesh_b = soup_to_manifold_mesh(soup_b);
    if (mesh_b.vertPos.empty()) {
      return error_soup_result("mesh_b: invalid triangle soup");
    }
    
    // Create Manifolds from meshes
    Manifold manifold_a(mesh_a);
    if (manifold_a.Status() != Manifold::Error::NoError) {
      return error_soup_result("mesh_a: failed to create valid manifold");
    }
    
    Manifold manifold_b(mesh_b);
    if (manifold_b.Status() != Manifold::Error::NoError) {
      return error_soup_result("mesh_b: failed to create valid manifold");
    }
    
    // Perform boolean union
    Manifold result = manifold_a + manifold_b;
    
    if (result.Status() != Manifold::Error::NoError) {
      return error_soup_result("Boolean union failed");
    }
    
    // Get result mesh
    Mesh result_mesh = result.GetMesh();
    
    // Convert back to triangle soup
    return manifold_mesh_to_soup(result_mesh);
    
  } catch (const std::exception& e) {
    return error_soup_result(std::string("Exception: ") + e.what());
  } catch (...) {
    return error_soup_result("Unknown exception during mesh union");
  }
}

// Perform boolean intersection: A ∩ B
extern "C" triangle_soup_result* manifold_intersect_meshes(const triangle_soup* soup_a, const triangle_soup* soup_b) {
  try {
    // Convert soups to Manifold meshes
    Mesh mesh_a = soup_to_manifold_mesh(soup_a);
    if (mesh_a.vertPos.empty()) {
      return error_soup_result("mesh_a: invalid triangle soup");
    }
    
    Mesh mesh_b = soup_to_manifold_mesh(soup_b);
    if (mesh_b.vertPos.empty()) {
      return error_soup_result("mesh_b: invalid triangle soup");
    }
    
    // Create Manifolds from meshes
    Manifold manifold_a(mesh_a);
    if (manifold_a.Status() != Manifold::Error::NoError) {
      return error_soup_result("mesh_a: failed to create valid manifold");
    }
    
    Manifold manifold_b(mesh_b);
    if (manifold_b.Status() != Manifold::Error::NoError) {
      return error_soup_result("mesh_b: failed to create valid manifold");
    }
    
    // Perform boolean intersection
    Manifold result = manifold_a ^ manifold_b;
    
    if (result.Status() != Manifold::Error::NoError) {
      return error_soup_result("Boolean intersection failed");
    }
    
    // Get result mesh
    Mesh result_mesh = result.GetMesh();
    
    // Convert back to triangle soup
    return manifold_mesh_to_soup(result_mesh);
    
  } catch (const std::exception& e) {
    return error_soup_result(std::string("Exception: ") + e.what());
  } catch (...) {
    return error_soup_result("Unknown exception during mesh intersection");
  }
}

// Helper function to free triangle soup result memory
extern "C" void free_triangle_soup_result(triangle_soup_result* result) {
  if (!result) return;
  
  free(result->vertices);
  free(result->error_message);
  free(result);
}