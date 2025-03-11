# SPDX-License-Identifier: CERN-OHL-S-2.0
import cadquery as cq

# tweakable param
sz_external = 20
slot_depth = 6
slot_fin_thickness = 1.5
slot_width_front = 6.2
slot_width_inside = 9.1
slot_chamfer = 1.5
beam_corner_radius = 1
# auto-computed
sz_internal = sz_external - slot_depth * 2

def make_channel(length):
  return (
    cq.Workplane("XY")
    # 1st slot
    .moveTo(0, sz_internal / 2)
    .hLine(slot_width_inside / 2 - slot_chamfer)
    .line(slot_chamfer, slot_chamfer)
    .vLineTo(sz_external / 2- slot_fin_thickness)
    .hLineTo(slot_width_front / 2)
    .vLine(slot_fin_thickness)
    .hLineTo(sz_external / 2)
    # 2nd slot
    .vLineTo(slot_width_front / 2)
    .hLine(-slot_fin_thickness)
    .vLineTo(slot_width_inside / 2)
    .hLineTo(sz_internal / 2 + slot_chamfer)
    .line(-slot_chamfer, -slot_chamfer)
    .vLineTo(0)  
    .mirrorX()
    .mirrorY()
    .extrude(length)
    .edges("(>X or <X) and (>Y or <Y)")
    .fillet(beam_corner_radius)
  )
