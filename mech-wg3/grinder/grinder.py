import marimo

__generated_with = "0.24.0"
app = marimo.App(width="medium")


@app.cell
def _():
    import marimo as mo
    import pint
    import math
    ureg = pint.UnitRegistry()
    Q = ureg.Quantity
    ureg.formatter.default_format = ".3g~P"

    def pprint_checks(header, checks) -> str:
        """
        checks: (label, actual, op, ref)
        op can be ">" or "<"
        """
        def line(label, actual, op, ref):
            if op == ">":
                margin = actual / ref
            elif op == "<":
                margin = ref / actual
            else:
                raise ValueError(f"unknown op {op!r}, expected '>' or '<'")
            mark = None
            if margin >= 5:
                mark = "✅"
            elif margin >= 1:
                mark = "⚠️"
            else:
                mark = "❌"
            return f"- {mark} **{float(margin):.2f}×** {label}: {actual:} ({op} {ref:})"

        return "\n".join(["**" + header + "**"] + [line(*check) for check in checks]) + "\n\n"


    return Q, math, mo, pprint_checks


@app.cell
def parts(Q):
    # https://www.stepperonline.jp/nema11%e3%83%90%e3%82%a4%e3%83%9d%e3%83%bc%e3%83%a91-8deg7ncm-9-91oz-in-0-67a-3-8v28x28x31mm4%e7%b7%9a-11hs12-0674s
    nema11_torque = Q("6 N*cm")
    nema11_speed = Q("500 rpm")

    mini_spool_min_dia = Q("50 mm")
    mini_spool_max_dia = Q("60 mm")

    puller_spool_max_dia = Q("26 mm")
    puller_spool_min_dia = Q("16 mm")
    puller_spool_dist_moment = Q("23 mm")

    # F684ZZ https://www.monotaro.com/p/5313/2163
    # ID=4mm
    bearing_cr = Q("640 N")

    gear_const = Q("4 N/mm**2")
    gear_eff = 0.95
    return (
        bearing_cr,
        gear_const,
        gear_eff,
        nema11_speed,
        nema11_torque,
        puller_spool_dist_moment,
        puller_spool_max_dia,
        puller_spool_min_dia,
    )


@app.cell
def spec(Q):
    targ_tension = Q("5 N") # experimental
    targ_speed = Q("6 mm/sec") # experimental

    return targ_speed, targ_tension


@app.cell
def _(
    Q,
    bearing_cr,
    gear_const,
    gear_eff,
    math,
    mo,
    nema11_speed,
    nema11_torque,
    pprint_checks,
    puller_spool_dist_moment,
    puller_spool_max_dia,
    puller_spool_min_dia,
    targ_speed,
    targ_tension,
):
    puller_tens = targ_tension * 2
    puller_max_torque = puller_tens * (puller_spool_max_dia / 2)

    gear_module = Q("0.8 mm")
    gear_width = Q("8 mm")
    bearing_dist = Q("9 mm")
    flange_dia = Q("14mm") # limited by 14mm: hole access (bearing OD + M2 CB head)
    flange_screw_f = Q("410N") # from M2x3 PLA expriement

    puller_ratio = 4 # ang_vel(spool)=ang_vel(motor)/puller_ratio
    motor_max_torque = puller_max_torque / puller_ratio / gear_eff
    puller_min_speed = nema11_speed / puller_ratio * (puller_spool_min_dia / 2)

    gear_z_motor = 12
    gear_z_spool = gear_z_motor * puller_ratio

    gear_max_tan_f = (nema11_torque / (gear_z_motor * gear_module / 2)).to("N")
    gear_max_rad_f = (gear_max_tan_f * math.tan(20 / 180 * math.pi)).to("N")

    # gear radial force support
    # D=4 is acceptable (<0.02mm) (via *deflection*)
    gear_rad_arm = puller_spool_dist_moment + gear_width
    bearing_max_rad_f = puller_tens * (gear_rad_arm / bearing_dist)
    bearing_l10 = (bearing_cr / (bearing_max_rad_f * 1.0))**3 * 1e6
    bearing_l10_in_meter = (bearing_l10 * math.pi * puller_spool_min_dia).to("km")

    flange_sc_f = puller_tens * (gear_rad_arm / (flange_dia / 2))

    dist_gear_center = (gear_z_motor + gear_z_spool) * gear_module / 2

    checks_puller = [
        ("puller speed", puller_min_speed, ">", targ_speed),
        ("motor torque", motor_max_torque, "<", nema11_torque),
        ("gear strength", gear_max_tan_f, "<", gear_const * gear_module * gear_width),
        ("bearing life (L10, wire km)", bearing_l10_in_meter, ">", Q("110 m") * 10000),
        ("flange screw", flange_sc_f, "<", flange_screw_f)
    ]

    mo.md(
        pprint_checks("puller", checks_puller) +
        "---\n" +
        f"* {gear_max_rad_f = :}\n" +
        f"* {gear_rad_arm = :}\n" + 
        f"* {bearing_max_rad_f = :}\n" +
        f"* {dist_gear_center = :}\n"
    )


    return


if __name__ == "__main__":
    app.run()
