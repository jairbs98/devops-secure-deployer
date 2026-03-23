const core = require('@actions/core');
const { NodeSSH } = require('node-ssh');

async function run() {
    const ssh = new NodeSSH();

    try {
        const inputs = {
            ip: core.getInput('vps_ip'),
            user: core.getInput('vps_user'),
            key: core.getInput('ssh_private_key'),
            mode: core.getInput('mode'),
            appName: core.getInput('app_name'),
            imageTag: core.getInput('image_tag'),
            hostUrl: core.getInput('host_url'),
            port: core.getInput('port'),
            ghToken: core.getInput('github_token'),
            ghRepo: core.getInput('github_repository'),
            ghActor: core.getInput('github_actor'),
        };

        const containerName = `${inputs.appName}-${inputs.imageTag}`;
        const imageRef = `ghcr.io/${inputs.ghRepo}:${inputs.imageTag}`;
        const workDir = `/tmp/deployment-${containerName}`;

        core.info(`Connecting to remote host ${inputs.ip} as ${inputs.user}...`);

        await ssh.connect({
            host: inputs.ip,
            username: inputs.user,
            privateKey: inputs.key
        });

        core.info('SSH connection established successfully.');

        if (inputs.mode === 'destroy') {
            core.startGroup(`Destroying environment: ${containerName}`);
            await ssh.execCommand(`docker stop ${containerName} || true`);
            await ssh.execCommand(`docker rm ${containerName} || true`);
            await ssh.execCommand('docker image prune -af || true');
            core.info('Environment destroyed.');
            core.endGroup();
            process.exit(0);
        }

        if (inputs.mode === 'deploy') {
            core.startGroup(`Deploying container: ${containerName}`);

            // 1. Prepare Environment Variables Securely
            let envContent = core.getInput('app_env_vars') ? core.getInput('app_env_vars') + '\n' : '';
            if (core.getInput('secret_key')) envContent += `SECRET_KEY=${core.getInput('secret_key')}\n`;
            if (core.getInput('db_name')) {
                envContent += `DB_NAME=${core.getInput('db_name')}\n`;
                envContent += `DB_HOST=db-pokemon-meta-container\n`;
            }
            if (core.getInput('db_user')) envContent += `DB_USER=${core.getInput('db_user')}\n`;
            if (core.getInput('db_pass')) envContent += `DB_PASS=${core.getInput('db_pass')}\n`;

            const envB64 = Buffer.from(envContent).toString('base64');

            // 2. Prepare Docker Compose configuration
            const composeContent = `
services:
  app:
    image: ${imageRef}
    container_name: ${containerName}
    env_file: .env
    restart: unless-stopped
    mem_limit: 300m
    networks:
      - web
    labels:
      - "traefik.enable=true"
      - "traefik.http.routers.${containerName}.rule=Host(\`${inputs.hostUrl}\`)"
      - "traefik.http.routers.${containerName}.tls=true"
      - "traefik.http.routers.${containerName}.tls.certresolver=myresolver"
      - "traefik.http.services.${containerName}.loadbalancer.server.port=${inputs.port}"
networks:
  web:
    external: true
`;
            const composeB64 = Buffer.from(composeContent).toString('base64');

            // 3. Execute remote commands
            core.info('Creating deployment directory...');
            await ssh.execCommand(`mkdir -p ${workDir}`);

            core.info('Transferring configuration files securely (Base64)...');
            await ssh.execCommand(`echo "${envB64}" | base64 -d > ${workDir}/.env`);
            await ssh.execCommand(`echo "${composeB64}" | base64 -d > ${workDir}/docker-compose.yml`);

            core.info('Authenticating with GitHub Container Registry...');
            await ssh.execCommand(`echo "${inputs.ghToken}" | docker login ghcr.io -u ${inputs.ghActor} --password-stdin`);

            core.info('Pulling image and starting services...');
            const deployResult = await ssh.execCommand(`cd ${workDir} && docker pull ${imageRef} && docker compose up -d`);

            if (deployResult.code !== 0) {
                throw new Error(`Docker compose failed: ${deployResult.stderr}`);
            }

            core.info('Cleaning up old orphaned images...');
            await ssh.execCommand('docker image prune -af || true');

            // Cleanup temp directory for security
            await ssh.execCommand(`rm -rf ${workDir}`);

            core.info(`Deployment active at https://${inputs.hostUrl}`);
            core.endGroup();
        }

    } catch (error) {
        core.setFailed(`Deployment failed: ${error.message}`);
    } finally {
        ssh.dispose();
    }
}

run();