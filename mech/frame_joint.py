# SPDX-License-Identifier: CERN-OHL-S-2.0
import cadquery as cq
channel_sz = 20

size = 20
m3_hole_dia = 3.3
m3_cap_dia = 7
cbore_fin_thickness = 3

def make_joint():
    corner_joint = (
        cq.Workplane("XY")
        .hLine(size)
        .lineTo(0, size)
        .lineTo(0, 0)
        .close()
        .extrude(channel_sz)
    )
    
    for plane in ["<X", "<Y"]:
        corner_joint = (
            corner_joint.faces(plane).workplane(centerOption="CenterOfMass", offset=size, invert=True)
            .cboreHole(m3_hole_dia, m3_cap_dia, size - cbore_fin_thickness)
            )
        
    corner_joint = (
        corner_joint
        .faces("#Z")
        .edges("%ELLIPSE")
        .chamfer(1.5)
    )
    
    corner_joint = (
        corner_joint
        .edges("|Z").chamfer(2)
        .edges("<Z or >Z").chamfer(.4)
    )
    return corner_joint
