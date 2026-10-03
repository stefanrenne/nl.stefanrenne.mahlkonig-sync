import Homey from 'homey';

export default class MahlkoenigSyncApp extends Homey.App {
  async onInit() {
    this.registerWidgetSettings();
    this.log('Mahlkönig Sync has been initialized');
  }

  /** The Espresso widget's grinder picker: the E64 WS devices whose name matches the query. */
  private registerWidgetSettings() {
    this.homey.dashboards.getWidget('espresso')
      .registerSettingAutocompleteListener('device', async (query: string) => {
        const search = query.trim().toLowerCase();
        return this.homey.drivers.getDriver('e64ws').getDevices()
          .map((device) => ({ name: device.getName(), id: String(device.getData().id) }))
          .filter((option) => search === '' || option.name.toLowerCase().includes(search))
          .sort((a, b) => a.name.localeCompare(b.name));
      });
  }
}
