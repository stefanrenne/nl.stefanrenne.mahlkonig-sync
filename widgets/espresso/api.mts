import type Homey from 'homey';
import type E64WSDevice from '../../drivers/e64ws/device.mjs';
import type { TimelineEntry } from '../../lib/summary.mjs';

type Request = {
  homey: Homey.App['homey'];
  query: Record<string, string>;
};

const COUNTS = [1, 3, 5, 10];

export default {
  /**
   * The latest grinds and shots of the E64 WS device chosen in the widget settings
   * (`?device=<data.id>&count=<1|3|5|10>`; any other count → 5).
   */
  async getTimeline({ homey, query }: Request): Promise<TimelineEntry[]> {
    const device = homey.drivers.getDriver('e64ws').getDevices()
      .find((candidate) => candidate.getData().id === query.device) as E64WSDevice | undefined;
    if (device === undefined) {
      throw new Error(homey.__('widget.noDevice'));
    }
    const requested = Number(query.count);
    return device.widgetTimeline(COUNTS.includes(requested) ? requested : 5);
  },
};
