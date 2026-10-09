# Plumber
## API Endpoints

The valve station config will accept connection strings with pre-shared keys with the stations.

### Stations
- GET <prefix>/list: List all configured stations and their status (online/offline)
- POST <prefix>/add: Add a new station to the control plane. Accept a body with a connection string that already has a given name that will be used to id the station by Plumber.
- DELETE <prefix>/remove/{name}: Remove a ValveStation by name.
- PUT <prefix>/update/: Make sure that all online stations' projects are updated to the latest version dictated by the control plane.

### Vault
- GET <prefix>/vault/catalog/list: List all available catalog files in the vault
- GET <prefix>/vault/catalog/{name}: View a catalog file in the vault
- PUT <prefix>/vault/catalog/{name}: Upload a catalog file to the vault
- DELETE <prefix>/vault/catalog/{name}: Delete a catalog file from the vault
- GET <prefix>/vault/parameters/list: List all available parameters files in the vault
- GET <prefix>/vault/parameters/{name}: View a parameters file in the vault
- PUT <prefix>/vault/parameters/{name}: Upload a parameters file to the vault
- DELETE <prefix>/vault/parameters/{name}: Delete a parameters file from the vault
- GET <prefix>/vault/credentials/list: List all available credentials files in the vault
- GET <prefix>/vault/credentials/{name}: View a credentials file in the vault
- PUT <prefix>/vault/credentials/{name}: Upload a credentials file to the vault
- DELETE <prefix>/vault/credentials/{name}: Delete a credentials file from the vault

### Project
- GET <prefix>/list: List all registered projects and variants. For a variant it will show the variant name, base project name and the used vault files (if any).
- POST <prefix>/register: Register a new project. Provide a repository, the branch to track, and a deploy key (if needed). Optionally allow an upload of a zip file that contains a project.
- PUT <prefix>/update/{name}: Update the registered project {name} by pulling from its repository or by uploading a zip file. The zip's canonada.toml must use that same name.
- POST <prefix>/register/variant: Register a project variant based on an existing project. Caller needs to provide the variant name and any vault files that need to be overridden (will alter canonada project name). A variant will update its base project files when a registered project is updated. Deleting the base project will delete all variants. (Variant names are treated as project names for the API endpoints; relations are only kept for project management and update purposes.)
- DELETE <prefix>/remove/{project}: Remove a Canonada project or variant. (By project name)

### Catalog
- GET <prefix>/view/catalog: View catalog entries available in each project and station. Actually asks each station, does not use the vault.
- GET <prefix>/view/parameters: View parameters available in each project and station. Actually asks each station, does not use the vault.

### Registry
- GET <prefix>/pipelines: List available pipelines and their descriptions (per project, not variant)
- GET <prefix>/systems: List available systems and their descriptions (per project, not variant)

### View
- GET <prefix>/pipeline/{project}/{pipeline}: View a pipeline's internal makeup (nodes and IO)
- GET <prefix>/system/{project}/{system}: View a system internal makeup (list of sequential pipeline)

### Run
- POST <prefix>/pipeline/{project}/{pipeline}: Run a pipeline on the station named by the station query parameter. If that station does not already have the same project files, the project is sent first.
- POST <prefix>/system/{project}/{system}: Run a system on the station named by the station query parameter. If that station does not already have the same project files, the project is sent first.
- DELETE <prefix>/pipeline/{station}/{project}/{pipeline}/{run}: Stop that pipeline run on the named station. A missing run is 404. A run that is not running is 409.
- DELETE <prefix>/system/{station}/{project}/{system}/{run}: Stop that system run on the named station. A missing run is 404. A run that is not running is 409.

### Logs
- GET <prefix>/pipelines: Read/List pipeline execution status for all stations (running/errored/finished)
- GET <prefix>/systems: Read/List system execution status (running/errored/finished)
- GET <prefix>/pipeline/{project}/{pipeline}: Read pipeline logs for all host stations.
- GET <prefix>/system/{project}/{system}: Read system logs for all host stations.

### Misc
- GET /version
- GET /health
