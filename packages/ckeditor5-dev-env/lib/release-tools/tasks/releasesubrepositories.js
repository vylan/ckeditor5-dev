/**
 * @license Copyright (c) 2003-2019, CKSource - Frederico Knabben. All rights reserved.
 * For licensing, see LICENSE.md.
 */

'use strict';

const fs = require( 'fs' );
const path = require( 'path' );
const chalk = require( 'chalk' );
const { tools, logger } = require( '@ckeditor/ckeditor5-dev-utils' );
const parseGithubUrl = require( 'parse-github-url' );
const cli = require( '../utils/cli' );
const createGithubRelease = require( '../utils/creategithubrelease' );
const displaySkippedPackages = require( '../utils/displayskippedpackages' );
const executeOnPackages = require( '../utils/executeonpackages' );
const { getChangesForVersion } = require( '../utils/changelog' );
const getPackageJson = require( '../utils/getpackagejson' );
const getSubRepositoriesPaths = require( '../utils/getsubrepositoriespaths' );
const GitHubApi = require( '@octokit/rest' );

const PACKAGE_JSON_TEMPLATE_PATH = require.resolve( '../templates/release-package.json' );
const BREAK_RELEASE_MESSAGE = 'You aborted publishing the release. Why? Oh why?!';
const NO_RELEASE_MESSAGE = 'No changes for publishing. Why? Oh why?!';

// That files will be copied from source to the temporary directory and will be released too.
const additionalFiles = [
	'CHANGELOG.md',
	'LICENSE.md',
	'README.md'
];

/**
 * Releases all sub-repositories (packages) found in specified path.
 *
 * This task does:
 *   - finds paths to sub repositories,
 *   - filters packages which should be released by comparing the latest version published on NPM and GitHub,,
 *   - publishes new version on NPM,
 *   - pushes new version to the remote repository,
 *   - creates a release which is displayed on "Releases" page on GitHub.
 *
 * If you want to publish an empty repository (only with required files for NPM), you can specify the package name
 * as `options.emptyReleases`. Packages specified in the array will be published from temporary directory. `package.json` of that package
 * will be created based on a template. See `packages/ckeditor5-dev-env/lib/release-tools/templates/release-package.json` file.
 *
 * Content of `package.json` can be adjusted using `options.packageJsonForEmptyReleases` options. If you need to copy values from
 * real `package.json` that are not defined in template, you can add these keys as null. Values will be copied automatically.
 *
 * Example usage:
 *
 *     require( '@ckeditor/ckeditor5-dev-env' )
 *         .releaseSubRepositories( {
 *		        cwd: process.cwd(),
 *		        packages: 'packages',
 *		        emptyReleases: [
 *			        'ckeditor5' // "ckeditor5" will be released as an empty repository.
 *		        ],
 *		        packageJsonForEmptyReleases: {
 *			        ckeditor5: { // These properties will overwrite those ones that are defined in package's `package.json`
 *				        description: 'Custom description', // "description" of real package will be overwritten.
 *				        devDependencies: null // The template does not contain "devDependencies" but we want to add it.
 *			        }
 *		        },
 *		        dryRun: process.argv.includes( '--dry-run' )
 *	} );
 *
 * Pushes are done at the end of the whole process because of Continues Integration. We need to publish all
 * packages on NPM before starting the CI testing. If we won't do it, CI will fail because it won't be able
 * to install packages which versions will match to specified in `package.json`.
 * See {@link https://github.com/ckeditor/ckeditor5-dev/issues/272}.
 *
 * @param {Object} options
 * @param {String} options.cwd Current working directory (packages) from which all paths will be resolved.
 * @param {String} options.packages Where to look for other packages (dependencies).
 * @param {Array.<String>} [options.skipPackages=[]] Name of packages which won't be released.
 * @param {Boolean} [options.dryRun=false] If set on true, nothing will be published:
 *   - npm pack will be called instead of npm publish (it packs the whole release to a ZIP archive),
 *   - "git push" will be replaced with a log on the screen,
 *   - creating a release on GitHub will be replaced with a log on the screen,
 *   - every called command will be displayed.
 * @param {Boolean} [options.skipMainRepository=false] If set on true, package found in "cwd" will be skipped.
 * @param {Array.<String>>} [options.emptyReleases=[]] Name of packages that should be published as an empty directory
 * except the real content from repository.
 * @param {Object} [options.packageJsonForEmptyReleases={}] Additional fields that will be added to `package.json` for packages which
 * will publish an empty directory. All properties copied from original package's "package.json" file will be overwritten by fields
 * specified in this option.
 * @param {Boolean} [options.skipMainRepository=false] If set on true, package found in "cwd" will be skipped.
 * @returns {Promise}
 */
module.exports = function releaseSubRepositories( options ) {
	const cwd = process.cwd();
	const log = logger();
	const dryRun = Boolean( options.dryRun );
	const emptyReleases = Array.isArray( options.emptyReleases ) ? options.emptyReleases : [ options.emptyReleases ].filter( Boolean );

	const pathsCollection = getSubRepositoriesPaths( {
		cwd: options.cwd,
		packages: options.packages,
		skipPackages: options.skipPackages || [],
		skipMainRepository: options.skipMainRepository
	} );

	logDryRun( '⚠️  DRY RUN mode ⚠️' );
	logDryRun( 'The script WILL NOT publish anything but will create some files.' );
	logProcess( 'Configuring the release...' );

	const github = new GitHubApi( {
		version: '3.0.0'
	} );

	// Collections of paths where different kind of releases should be done.
	// `releasesOnNpm` - the release on NPM that contains the entire repository (npm publish is executed inside the repository)
	// `emptyReleasesOnNpm` - the release on NPM that contains an empty repository (npm publish is executed from a temporary directory)
	// `releasesOnGithub` - the release on GitHub (there is only one command called - `git push` and creating the release via REST API)
	const releasesOnNpm = new Set();
	const releasesOnGithub = new Set();
	const emptyReleasesOnNpm = new Map();

	// List of packages that were released on NPM or/and GitHub.
	const releasedPackages = new Set();

	// List of files that should be removed in DRY RUN mode. This is a result of command `npm pack`.
	const filesToRemove = new Set();

	// List of all details required for releasing packages.
	const packages = new Map();

	let releaseOptions;

	return cli.configureReleaseOptions()
		.then( _releaseOptions => saveReleaseOptions( _releaseOptions ) )
		.then( () => preparePackagesToRelease() )
		.then( () => filterPackagesToReleaseOnNpm() )
		.then( () => filterPackagesToReleaseOnGitHub() )
		.then( () => confirmRelease() )
		.then( () => prepareDirectoriesForEmptyReleases() )
		.then( () => releasePackagesOnNpm() )
		.then( () => pushPackages() )
		.then( () => createReleasesOnGitHub() )
		.then( () => removeTemporaryDirectories() )
		.then( () => removeReleaseArchives() )
		.then( () => {
			process.chdir( cwd );

			logProcess( `Finished releasing ${ chalk.underline( releasedPackages.size ) } packages.` );
			logDryRun( 'Because of the DRY RUN mode, nothing has been changed. All changes were reverted.' );
		} )
		.catch( err => {
			process.chdir( cwd );

			// A user did not confirm the release process or there is nothing to release.
			if ( err instanceof Error ) {
				if ( err.message === BREAK_RELEASE_MESSAGE ) {
					logProcess( 'Publishing has been aborted.' );

					return Promise.resolve();
				}

				if ( err.message === NO_RELEASE_MESSAGE ) {
					logProcess( 'There is nothing to release. The process was aborted.' );

					return Promise.resolve();
				}
			}

			log.error( dryRun ? err.stack : err.message );

			process.exitCode = -1;
		} );

	// Saves the options provided by a user.
	//
	// @param {Object} _releaseOptions
	function saveReleaseOptions( _releaseOptions ) {
		releaseOptions = _releaseOptions;

		if ( !releaseOptions.npm && !releaseOptions.github ) {
			throw new Error( BREAK_RELEASE_MESSAGE );
		}

		if ( releaseOptions.github ) {
			github.authenticate( {
				token: releaseOptions.token,
				type: 'oauth',
			} );
		}
	}

	// Prepares a version, a description and other necessary things that must be done before starting
	// the entire a releasing process.
	//
	// @returns {Promise}
	function preparePackagesToRelease() {
		logProcess( 'Preparing packages that will be released...' );

		displaySkippedPackages( pathsCollection.skipped );

		return executeOnPackages( pathsCollection.matched, repositoryPath => {
			process.chdir( repositoryPath );

			const packageJson = getPackageJson( repositoryPath );
			const releaseDetails = {
				version: packageJson.version,
				changes: getChangesForVersion( packageJson.version, repositoryPath )
			};

			packages.set( packageJson.name, releaseDetails );

			if ( releaseOptions.github ) {
				const repositoryInfo = parseGithubUrl(
					exec( 'git remote get-url origin --push' ).trim()
				);

				releaseDetails.repositoryOwner = repositoryInfo.owner;
				releaseDetails.repositoryName = repositoryInfo.name;
			}

			return Promise.resolve();
		} );
	}

	// Checks which packages should be published on NPM. It compares version defined in `package.json`
	// and the latest released on NPM.
	//
	// @returns {Promise}
	function filterPackagesToReleaseOnNpm() {
		if ( !releaseOptions.npm ) {
			return Promise.resolve();
		}

		logProcess( 'Collecting the latest versions of packages published on NPM...' );

		return executeOnPackages( pathsCollection.matched, repositoryPath => {
			process.chdir( repositoryPath );

			const packageJson = getPackageJson( repositoryPath );
			const releaseDetails = packages.get( packageJson.name );

			log.info( `\nChecking "${ chalk.underline( packageJson.name ) }"...` );

			const npmVersion = exec( `npm show ${ packageJson.name } version` ).trim();

			logDryRun( `Versions: package.json: "${ releaseDetails.version }", npm: "${ npmVersion }".` );

			releaseDetails.npmVersion = npmVersion;
			releaseDetails.shouldReleaseOnNpm = npmVersion !== releaseDetails.version;

			if ( releaseDetails.shouldReleaseOnNpm ) {
				logDryRun( 'Package will be released.' );

				releasesOnNpm.add( repositoryPath );
			} else {
				log.info( '❌  Nothing to release.' );
			}

			return Promise.resolve();
		} );
	}

	// Checks for which packages GitHub release should be created. It compares version defined in `package.json`
	// and the latest release on GitHub.
	//
	// @returns {Promise}
	function filterPackagesToReleaseOnGitHub() {
		if ( !releaseOptions.github ) {
			return Promise.resolve();
		}

		logProcess( 'Collecting the latest releases published on GitHub...' );

		return executeOnPackages( pathsCollection.matched, repositoryPath => {
			process.chdir( repositoryPath );

			const packageJson = getPackageJson( repositoryPath );
			const releaseDetails = packages.get( packageJson.name );

			log.info( `\nChecking "${ chalk.underline( packageJson.name ) }"...` );

			return getLastRelease( releaseDetails.repositoryOwner, releaseDetails.repositoryName )
				.then( ( { data } ) => {
					// It can be `null` if there is no releases on GitHub.
					let githubVersion = data.tag_name;

					if ( githubVersion ) {
						githubVersion = data.tag_name.replace( /^v/, '' );
					}

					logDryRun(
						`Versions: package.json: "${ releaseDetails.version }", GitHub: "${ githubVersion || 'initial release' }".`
					);

					releaseDetails.githubVersion = githubVersion;
					releaseDetails.shouldReleaseOnGithub = githubVersion !== releaseDetails.version;

					if ( releaseDetails.shouldReleaseOnGithub ) {
						logDryRun( 'Package will be published.' );

						releasesOnGithub.add( repositoryPath );
					} else {
						log.info( '❌  Nothing to publish.' );
					}
				} )
				.catch( err => {
					log.warning( err );
				} );
		} );

		function getLastRelease( repositoryOwner, repositoryName ) {
			const requestParams = {
				owner: repositoryOwner,
				repo: repositoryName
			};

			return new Promise( ( resolve, reject ) => {
				github.repos.getLatestRelease( requestParams, ( err, responses ) => {
					if ( err ) {
						// No releases on GitHub. It will be the first one.
						if ( err.message.toLowerCase() == 'not found' ) {
							return resolve( {
								data: {
									tag_name: null
								}
							} );
						}

						return reject( err );
					}

					return resolve( responses );
				} );
			} );
		}
	}

	// Asks a user whether the process should be continued.
	//
	// @params {Map.<String, ReleaseDetails>} packages
	// @returns {Promise}
	function confirmRelease() {
		// No packages for releasing...
		if ( !releasesOnNpm.size && !releasesOnGithub.size ) {
			throw new Error( NO_RELEASE_MESSAGE );
		}

		logProcess( 'Should we continue?' );

		return cli.confirmPublishing( packages )
			.then( isConfirmed => {
				if ( !isConfirmed ) {
					throw new Error( BREAK_RELEASE_MESSAGE );
				}
			} );
	}

	// Prepares empty repositories that will be released.
	//
	// @returns {Promise}
	function prepareDirectoriesForEmptyReleases() {
		if ( !releaseOptions.npm ) {
			return Promise.resolve();
		}

		logProcess( 'Preparing directories for empty releases...' );

		return executeOnPackages( releasesOnNpm, repositoryPath => {
			process.chdir( repositoryPath );

			const packageJson = getPackageJson( repositoryPath );

			if ( !emptyReleases.includes( packageJson.name ) ) {
				return Promise.resolve();
			}

			log.info( `\nPreparing "${ chalk.underline( packageJson.name ) }"...` );

			const tmpDir = fs.mkdtempSync( repositoryPath + path.sep + '.release-directory-' );
			const tmpPackageJsonPath = path.join( tmpDir, 'package.json' );

			releasesOnNpm.delete( repositoryPath );
			emptyReleasesOnNpm.set( tmpDir, repositoryPath );

			// Copy `package.json` template.
			exec( `cp ${ PACKAGE_JSON_TEMPLATE_PATH } ${ tmpPackageJsonPath }` );

			// Copy additional files.
			for ( const file of additionalFiles ) {
				exec( `cp ${ path.join( repositoryPath, file ) } ${ path.join( tmpDir, file ) }` );
			}

			logDryRun( 'Updating package.json...' );

			// Update `package.json` file. It uses values from source `package.json`
			// but only these ones which are defined in the template.
			// Properties that were passed as `options.packageJsonForEmptyReleases` will not be overwritten.
			tools.updateJSONFile( tmpPackageJsonPath, jsonFile => {
				const additionalPackageJson = options.packageJsonForEmptyReleases[ packageJson.name ] || {};

				// Overwrite custom values specified in `options.packageJsonForEmptyReleases`.
				for ( const property of Object.keys( additionalPackageJson ) ) {
					jsonFile[ property ] = additionalPackageJson[ property ];
				}

				// Copy values from original package.json file.
				for ( const property of Object.keys( jsonFile ) ) {
					// If the `property` is set, leave it.
					if ( jsonFile[ property ] ) {
						continue;
					}

					jsonFile[ property ] = packageJson[ property ];
				}

				return jsonFile;
			} );

			return Promise.resolve();
		} );
	}

	// Publishes all packages on npm. In `dry run` mode it will create an archive instead of publishing the package.
	//
	// @returns {Promise}
	function releasePackagesOnNpm() {
		if ( !releaseOptions.npm ) {
			return Promise.resolve();
		}

		logProcess( 'Publishing on NPM...' );

		const paths = [
			...emptyReleasesOnNpm.keys(),
			...releasesOnNpm
		];

		return executeOnPackages( paths, repositoryPath => {
			process.chdir( repositoryPath );

			const packageJson = getPackageJson( repositoryPath );

			log.info( `\nPublishing "${ chalk.underline( packageJson.name ) }" as "v${ packageJson.version }"...` );
			logDryRun( 'Do not panic. DRY RUN mode is active. An archive with the release will be created instead.' );

			const repositoryRealPath = emptyReleasesOnNpm.get( repositoryPath ) || repositoryPath;

			if ( dryRun ) {
				const archiveName = packageJson.name.replace( '@', '' ).replace( '/', '-' ) + `-${ packageJson.version }.tgz`;

				exec( 'npm pack' );

				// Move created archive from temporary directory because the directory will be removed automatically.
				if ( emptyReleasesOnNpm.has( repositoryPath ) ) {
					exec( `mv ${ path.join( repositoryPath, archiveName ) } ${ path.resolve( repositoryRealPath ) }` );
				}

				// Mark created archive as a file to remove.
				filesToRemove.add( path.join( repositoryRealPath, archiveName ) );
			} else {
				exec( 'npm publish --access=public' );
			}

			releasedPackages.add( repositoryRealPath );
		} );
	}

	// Pushes all changes to remote.
	//
	// @params {Map.<String, ReleaseDetails>} packages
	// @returns {Promise}
	function pushPackages() {
		logProcess( 'Pushing packages to the remote...' );

		return executeOnPackages( releasesOnGithub, repositoryPath => {
			process.chdir( repositoryPath );

			const packageJson = getPackageJson( repositoryPath );
			const releaseDetails = packages.get( packageJson.name );

			log.info( `\nPushing "${ chalk.underline( packageJson.name ) }" package...` );

			if ( dryRun ) {
				logDryRun( `Command: "git push origin master v${ releaseDetails.version }" would be executed.` );
			} else {
				exec( `git push origin master v${ releaseDetails.version }` );
			}

			return Promise.resolve();
		} );
	}

	// Creates the releases on GitHub. In `dry run` mode it will just print a URL to release.
	//
	// @returns {Promise}
	function createReleasesOnGitHub() {
		if ( !releaseOptions.github ) {
			return Promise.resolve();
		}

		logProcess( 'Creating releases on GitHub...' );

		return executeOnPackages( releasesOnGithub, repositoryPath => {
			process.chdir( repositoryPath );

			const packageJson = getPackageJson( repositoryPath );
			const releaseDetails = packages.get( packageJson.name );

			log.info( `\nCreating a GitHub release for "${ packageJson.name }"...` );

			// eslint-disable-next-line max-len
			const url = `https://github.com/${ releaseDetails.repositoryOwner }/${ releaseDetails.repositoryName }/releases/tag/v${ releaseDetails.version }`;

			logDryRun( `Created release will be available under: ${ chalk.underline( url ) }` );

			if ( dryRun ) {
				return Promise.resolve();
			}

			const githubReleaseOptions = {
				repositoryOwner: releaseDetails.repositoryOwner,
				repositoryName: releaseDetails.repositoryName,
				version: `v${ releaseDetails.version }`,
				description: releaseDetails.changes
			};

			return createGithubRelease( releaseOptions.token, githubReleaseOptions )
				.then(
					() => {
						releasedPackages.add( repositoryPath );

						log.info( `Created the release: ${ chalk.green( url ) }` );

						return Promise.resolve();
					},
					err => {
						log.info( 'Cannot create a release on GitHub. Skipping that package.' );
						log.error( err );

						return Promise.resolve();
					}
				);
		} );
	}

	// Removes all temporary directories that were created for publishing an empty repository.
	//
	// @returns {Promise}
	function removeTemporaryDirectories() {
		if ( !releaseOptions.npm ) {
			return Promise.resolve();
		}

		logProcess( 'Removing temporary directories that were created for publishing on NPM...' );

		return executeOnPackages( emptyReleasesOnNpm.keys(), repositoryPath => {
			process.chdir( emptyReleasesOnNpm.get( repositoryPath ) );

			exec( `rm -rf ${ repositoryPath }` );
		} );
	}

	// Asks the user whether created archives should be removed. It so, the script will remove them.
	//
	// @returns {Promise}
	function removeReleaseArchives() {
		// This step should be skipped if packages won't be released on NPM or if dry run mode is disabled.
		if ( !releaseOptions.npm || !dryRun ) {
			return Promise.resolve();
		}

		logProcess( 'Removing archives created by "npm pack" command...' );

		return cli.confirmRemovingFiles()
			.then( shouldRemove => {
				process.chdir( cwd );

				if ( !shouldRemove ) {
					logDryRun( 'You can remove these files manually by calling `git clean -f` command.' );
					logDryRun( 'It will also work using mgit: `mgit exec "git clean -f"`' );

					return;
				}

				for ( const file of filesToRemove ) {
					exec( `rm ${ file }` );
				}
			} );
	}

	function exec( command ) {
		if ( dryRun ) {
			log.info( `⚠️  ${ chalk.grey( 'Execute:' ) } "${ chalk.cyan( command ) }" in "${ chalk.grey.italic( process.cwd() ) }".` );
		}

		return tools.shExec( command, { verbosity: 'error' } );
	}

	function logProcess( message ) {
		log.info( '\n📍  ' + chalk.blue( message ) );
	}

	function logDryRun( message ) {
		if ( dryRun ) {
			log.info( 'ℹ️  ' + chalk.yellow( message ) );
		}
	}
};
