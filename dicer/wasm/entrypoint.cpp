// All coordinates are right-handed.

#include <stdlib.h>
#include <string.h>
#include <vector>

// For future CGAL integration
// #include <CGAL/Exact_predicates_inexact_constructions_kernel.h>
// #include <CGAL/Surface_mesh.h>
// #include <CGAL/Polygon_mesh_processing/polygon_soup_to_polygon_mesh.h>
// typedef CGAL::Exact_predicates_inexact_constructions_kernel K;
// typedef CGAL::Surface_mesh<K::Point_3> Mesh;

typedef struct {
    float x;
    float y;
} vector2;

typedef struct {
    float x;
    float y;
    float z;
} vector3;

typedef struct {
    int vs[3];
} tri_ix;

// Triangle soup with no holes or self-intersections.
typedef struct {
    int num_vertices;
    vector3* vertices;
} triangle_soup;

// Outward-facing contour: CCW, inward-facing: CW.
typedef struct {
    int num_vertices;
    vector2* vertices;
} contour;

typedef struct {
    int num_countours;
    contour* contours;
} contour_soup;

// Helper function to convert triangle soup to indexed mesh format
// This deduplicates vertices for CGAL mesh construction
static void soup_to_indexed(
    const triangle_soup* soup,
    std::vector<vector3>& vertices,
    std::vector<tri_ix>& triangles
) {
    // For trivial implementation, just copy all vertices
    // (no deduplication yet - each triangle has its own 3 vertices)
    int num_tris = soup->num_vertices / 3;
    vertices.reserve(soup->num_vertices);
    triangles.reserve(num_tris);
    
    for (int i = 0; i < soup->num_vertices; i++) {
        vertices.push_back(soup->vertices[i]);
    }
    
    for (int t = 0; t < num_tris; t++) {
        tri_ix tri;
        tri.vs[0] = t * 3 + 0;
        tri.vs[1] = t * 3 + 1;
        tri.vs[2] = t * 3 + 2;
        triangles.push_back(tri);
    }
}

// Project 3D mesh onto a plane defined by view_dir_z and origin.
// view_x, view_y, view_dir_z are orthogonal basis. (i.e. view_x x view_y = view_dir_z, view_y x view_dir_z = view_x, view_dir_z x view_x = view_y).
// Returns silhouette contours of the mesh projected onto the view plane.
//
// Caller must free the returned data.
extern "C" contour_soup* project_mesh(
    const triangle_soup* soup,
    const vector3* origin,
    const vector3* view_x,
    const vector3* view_y,
    const vector3* view_dir_z
) {
    // Part A: Convert triangle soup to indexed mesh
    std::vector<vector3> vertices;
    std::vector<tri_ix> triangles;
    soup_to_indexed(soup, vertices, triangles);
    
    // Future: Use CGAL's polygon_soup_to_polygon_mesh here
    // Mesh mesh;
    // PMP::polygon_soup_to_polygon_mesh(points, polygons, mesh);
    
    // Part B: Generate contours (trivial implementation for now)
    // Returns a simple square contour for testing
    
    contour_soup* result = (contour_soup*)malloc(sizeof(contour_soup));
    result->num_countours = 1;
    result->contours = (contour*)malloc(sizeof(contour));
    
    // Create a test square contour in 2D
    result->contours[0].num_vertices = 4;
    result->contours[0].vertices = (vector2*)malloc(4 * sizeof(vector2));
    
    // Square from -1 to 1 in view plane coordinates
    result->contours[0].vertices[0] = {-1.0f, -1.0f};
    result->contours[0].vertices[1] = { 1.0f, -1.0f};
    result->contours[0].vertices[2] = { 1.0f,  1.0f};
    result->contours[0].vertices[3] = {-1.0f,  1.0f};
    
    return result;
}

// Helper function to free contour soup memory
extern "C" void free_contour_soup(contour_soup* soup) {
    if (!soup) return;
    
    for (int i = 0; i < soup->num_countours; i++) {
        free(soup->contours[i].vertices);
    }
    free(soup->contours);
    free(soup);
}
