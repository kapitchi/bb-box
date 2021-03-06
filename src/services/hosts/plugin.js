const {AbstractService, Joi} = require('@kapitchi/bb-service');
const _ = require('lodash');

class HostsPlugin extends AbstractService {
  constructor() {
    super();
  }

  register(box) {
    this.box = box;
  }

  onCli(program) {
    program.command('hosts').action(async () => {
      const service = await this.box.discover();
      this.showHosts(service);
    });
  }

  showHosts(rootService) {
    const hosts = [];
    for (const serviceName in rootService.services) {
      const service = rootService.services[serviceName];
      if (_.isEmpty(service.expose)) {
        continue;
      }
        
      //TODO we take first
      const expose = _.first(service.expose);

      hosts.push(`${expose.ip} ${service.name} # ${service.name}:${expose.port}, docker-compose extra_hosts: - "${service.name}:${expose.ip}"`);
    }
      
    console.log(hosts.join("\n"));
  }
}

module.exports = HostsPlugin;
