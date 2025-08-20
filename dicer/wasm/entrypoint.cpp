// All coordinates are right-handed.

#include <stdlib.h>
#include <string.h>
#include <vector>
#include <algorithm>
#include <cmath>

#include <CGAL/Exact_predicates_inexact_constructions_kernel.h>
#include <CGAL/Surface_mesh.h>
#include <CGAL/Polygon_mesh_processing/polygon_soup_to_polygon_mesh.h>
#include <CGAL/Polygon_mesh_processing/compute_normal.h>

typedef CGAL::Exact_predicates_inexact_constructions_kernel K;
typedef K::Point_3 Point_3;
typedef K::Vector_3 Vector_3;
typedef K::Point_2 Point_2;
typedef CGAL::Surface_mesh<Point_3> Mesh;
typedef Mesh::Face_index Face_index;
typedef Mesh::Vertex_index Vertex_index;
typedef Mesh::Edge_index Edge_index;
typedef Mesh::Halfedge_index Halfedge_index;

namespace PMP = CGAL::Polygon_mesh_processing;

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
} edge_soup;

// Helper to convert vector3 to CGAL Point_3
static Point_3 to_point3(const vector3& v) {
    return Point_3(v.x, v.y, v.z);
}

// Helper to convert vector3 to CGAL Vector_3
static Vector_3 to_vector3(const vector3& v) {
    return Vector_3(v.x, v.y, v.z);
}

// Project 3D point onto 2D plane defined by origin and basis vectors
static Point_2 project_to_plane(
    const Point_3& point,
    const Point_3& origin,
    const Vector_3& x_axis,
    const Vector_3& y_axis
) {
    Vector_3 v = point - origin;
    double x = v * x_axis;  // dot product
    double y = v * y_axis;  // dot product
    return Point_2(x, y);
}

// Project 3D mesh onto a plane defined by view_dir_z and origin.
// Returns silhouette edges projected onto the view plane.
//
// Caller must free the returned data.
extern "C" edge_soup* project_mesh(
    const triangle_soup* soup,
    const vector3* origin,
    const vector3* view_x,
    const vector3* view_y,
    const vector3* view_dir_z
) {
    // Validate input
    if (!soup || !soup->vertices || soup->num_vertices <= 0 || soup->num_vertices % 3 != 0) {
        edge_soup* result = (edge_soup*)malloc(sizeof(edge_soup));
        result->num_edges = 0;
        result->edges = nullptr;
        return result;
    }
    
    // Convert input vectors to CGAL types
    Point_3 origin_pt = to_point3(*origin);
    Vector_3 x_axis = to_vector3(*view_x);
    Vector_3 y_axis = to_vector3(*view_y);
    Vector_3 view_dir = to_vector3(*view_dir_z);
    
    // Part A: Convert triangle soup to CGAL Surface_mesh
    std::vector<Point_3> points;
    std::vector<std::vector<std::size_t>> polygons;
    
    // Build points and polygons for CGAL
    int num_tris = soup->num_vertices / 3;
    points.reserve(soup->num_vertices);
    polygons.reserve(num_tris);
    
    // Add all vertices (no deduplication for now)
    for (int i = 0; i < soup->num_vertices; i++) {
        points.push_back(Point_3(
            soup->vertices[i].x,
            soup->vertices[i].y,
            soup->vertices[i].z
        ));
    }
    
    // Create triangles
    for (int t = 0; t < num_tris; t++) {
        std::vector<std::size_t> triangle;
        triangle.push_back(t * 3 + 0);
        triangle.push_back(t * 3 + 1);
        triangle.push_back(t * 3 + 2);
        polygons.push_back(triangle);
    }
    
    // Build CGAL mesh
    Mesh mesh;
    PMP::polygon_soup_to_polygon_mesh(points, polygons, mesh);
    
    // Check if mesh is valid
    if (mesh.is_empty() || !mesh.is_valid()) {
        // Failed to create valid mesh - return empty result
        edge_soup* result = (edge_soup*)malloc(sizeof(edge_soup));
        result->num_edges = 0;
        result->edges = nullptr;
        return result;
    }
    
    // Part B: Find silhouette edges
    std::vector<edge_2d> silhouette_edges;
    
    for (auto e : mesh.edges()) {
        Halfedge_index h1 = mesh.halfedge(e);
        Halfedge_index h2 = mesh.opposite(h1);
        
        // Check if edge is on boundary (only one adjacent face)
        if (mesh.is_border(h1) || mesh.is_border(h2)) {
            // Boundary edges are always part of silhouette
            Vertex_index v1 = mesh.source(h1);
            Vertex_index v2 = mesh.target(h1);
            
            Point_3 p1_3d = mesh.point(v1);
            Point_3 p2_3d = mesh.point(v2);
            
            Point_2 p1_2d = project_to_plane(p1_3d, origin_pt, x_axis, y_axis);
            Point_2 p2_2d = project_to_plane(p2_3d, origin_pt, x_axis, y_axis);
            
            edge_2d edge;
            edge.start.x = CGAL::to_double(p1_2d.x());
            edge.start.y = CGAL::to_double(p1_2d.y());
            edge.end.x = CGAL::to_double(p2_2d.x());
            edge.end.y = CGAL::to_double(p2_2d.y());
            
            silhouette_edges.push_back(edge);
            continue;
        }
        
        Face_index f1 = mesh.face(h1);
        Face_index f2 = mesh.face(h2);
        
        // Compute face normals
        Vector_3 n1 = PMP::compute_face_normal(f1, mesh);
        Vector_3 n2 = PMP::compute_face_normal(f2, mesh);
        
        // Check if faces have different visibility
        double dot1 = n1 * view_dir;
        double dot2 = n2 * view_dir;
        
        // If one face is front-facing and other is back-facing/orthogonal, it's a silhouette edge
        if ((dot1 > 0 && dot2 <= 0) || (dot1 <= 0 && dot2 > 0)) {
            Vertex_index v1 = mesh.source(h1);
            Vertex_index v2 = mesh.target(h1);
            
            Point_3 p1_3d = mesh.point(v1);
            Point_3 p2_3d = mesh.point(v2);
            
            Point_2 p1_2d = project_to_plane(p1_3d, origin_pt, x_axis, y_axis);
            Point_2 p2_2d = project_to_plane(p2_3d, origin_pt, x_axis, y_axis);
            
            edge_2d edge;
            edge.start.x = CGAL::to_double(p1_2d.x());
            edge.start.y = CGAL::to_double(p1_2d.y());
            edge.end.x = CGAL::to_double(p2_2d.x());
            edge.end.y = CGAL::to_double(p2_2d.y());
            
            silhouette_edges.push_back(edge);
        }
    }
    
    // Convert to output format
    edge_soup* result = (edge_soup*)malloc(sizeof(edge_soup));
    result->num_edges = silhouette_edges.size();
    
    if (result->num_edges > 0) {
        result->edges = (edge_2d*)malloc(sizeof(edge_2d) * result->num_edges);
        for (size_t i = 0; i < silhouette_edges.size(); i++) {
            result->edges[i] = silhouette_edges[i];
        }
    } else {
        result->edges = nullptr;
    }
    
    return result;
}

// Helper function to free edge soup memory
extern "C" void free_edge_soup(edge_soup* soup) {
    if (!soup) return;
    
    free(soup->edges);
    free(soup);
}