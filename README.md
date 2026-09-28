# Plumber
## API Endpoints

The valve station config will accept connection strings with pre-shared keys with the stations.

### Stations
- GET <prefix>/list: List all configured stations and their status (online/offline)
- POST <prefix>/add: Add a new station to the control plane. Accept a body with a connection string that already has a given name that will be used to id the station by Plumber.
- DELETE <prefix>/remove/{name}: Remove a ValveStation by name.

### Project
- PUT <prefix>/register: Register a new project, provide a repository and deploy key (if needed)
- DELETE <prefix>/remove/{project}: Remove a Canonada project from the node. (By project name)

### Catalog
- GET <prefix>/view/catalog: View catalog entries available in each project of each station
- GET <prefix>/view/parameters: View parameters available in each project of each station
- PUT <prefix>/inject/parameters: Inject a new parameters file, specify a station and project
- PUT <prefix>/inject/catalog: Inject a new catalog file, specify a station and project
- PUT <prefix>/inject/credentials: Inject a new credentials file, specify a station and project

### Registry
- GET <prefix>/pipelines: List available pipelines and their descriptions (per project)
- GET <prefix>/systems: List available systems and their descriptions (per project)
- GET <prefix>/projects: Lists the available Canonada projects in this instance

### View
- GET <prefix>/pipeline/{project}/{pipeline}: View a pipeline's internal makeup (nodes and IO)
- GET <prefix>/system/{project}/{system}: View a system internal makeup (list of sequential pipeline)

### Run
- POST <prefix>/pipeline: Run a pipeline and save its full output into a log file -> API keeps track of the running process state (internal list)
- POST <prefix>/system: Run a system and save its full output into a log file -> API keeps track of the running process state

### Logs
- GET <prefix>/pipelines: Read/List pipeline execution status (running/errored/finished)
- GET <prefix>/systems: Read/List system execution status (running/errored/finished)
- GET <prefix>/pipeline/{project}/{pipeline}: Read pipeline logs. Read from the log file for the requested process
- GET <prefix>/pipeline/{project}/{system}: Read system logs. Read from the log file for the requested process

### Misc
- GET /version
- GET /health
- GET /logs -> Flow valve internal logs
