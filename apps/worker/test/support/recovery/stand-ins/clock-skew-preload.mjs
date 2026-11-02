// A worker whose machine's clock is off. Nothing it writes to a run's history should
// show it: those times are the database's. Only this process's own clock moves.
const skew = Number(process.env.CLOCK_SKEW_STAND_IN_MILLIS);
const RealDate = Date;

class SkewedDate extends RealDate {
  constructor(...values) {
    if (values.length === 0) super(RealDate.now() + skew);
    else super(...values);
  }

  static now() {
    return RealDate.now() + skew;
  }
}

globalThis.Date = SkewedDate;
