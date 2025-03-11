# SPDX-License-Identifier: CERN-OHL-S-2.0
import cadquery as cq
channel_sz = 20

size = 20
hole_dia = 5
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
            #.circle(hole_dia).cutThruAll()
            #.circle(hole_dia * 2).cut()
            .cboreHole(3.2, 5, size - cbore_fin_thickness)
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
