import type Homey from 'homey';
import type E64WSDevice from '../../drivers/e64ws/device.mjs';
import type { TimelineEntry } from '../../lib/summary.mjs';

type Request = {
  homey: Homey.App['homey'];
  query: Record<string, string>;
};

export default {
  /** The last 24 hours of the E64 WS device chosen in the widget settings (`?device=<data.id>`). */
  async getTimeline({ homey, query }: Request): Promise<TimelineEntry[]> {
    const device = homey.drivers.getDriver('e64ws').getDevices()
      .find((candidate) => candidate.getData().id === query.device) as E64WSDevice | undefined;
    if (device === undefined) {
      throw new Error(homey.__('widget.noDevice'));
    }
    return device.widgetTimeline(Date.now());
  },
};
