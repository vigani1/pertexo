import { relative } from 'node:path';

/** Module duration includes the real outages in beforeAll and cleanup in afterAll. */
export default class FaultDurations {
  durations = {};

  onTestModuleEnd(module) {
    this.durations[relative(process.cwd(), module.moduleId)] = Math.round(
      module.diagnostic().duration,
    );
  }

  onTestRunEnd() {
    console.log('Fault durations (milliseconds; paste into durations.json):');
    console.log(JSON.stringify(this.durations, null, 2));
  }
}
