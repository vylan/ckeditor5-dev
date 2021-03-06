/**
 * @license Copyright (c) 2003-2019, CKSource - Frederico Knabben. All rights reserved.
 * For licensing, see LICENSE.md.
 */

'use strict';

const transformCommitForSubRepository = require( './transformcommitforsubrepository' );
const getChangedFilesForCommit = require( './getchangedfilesforcommit' );

/**
 * Parses a single commit for package which is located in multi-package repository.
 *
 * The commit will be parsed only if its at least one file is located in current processing package.
 *
 * Returns `undefined` if given commit should not be added to the changelog. This behavior can be changed
 * using the `context.returnInvalidCommit` option.
 *
 * @param {Commit} rawCommit
 * @param {Object} context
 * @param {Object} context.packageData Content from the 'package.json' for given package.
 * @returns {Commit|undefined}
 */
module.exports = function transformCommitForSubPackage( rawCommit, context ) {
	// Let's clone the commit. We don't want to modify the reference.
	const commit = Object.assign( {}, rawCommit, {
		notes: rawCommit.notes.map( note => Object.assign( {}, note ) )
	} );

	// Skip the Lerna "Publish" commit.
	if ( !commit.type && commit.header === 'Publish' && commit.body ) {
		return;
	}

	// Our merge commit always contains two lines:
	// Merge ...
	// Prefix: Subject of the changes.
	// Unfortunately, merge commit made by Git does not contain the second line.
	// Because of that hash of the commit is parsed as a body and the changelog will crash.
	// See: https://github.com/ckeditor/ckeditor5-dev/issues/276.
	if ( commit.merge && !commit.hash ) {
		commit.hash = commit.body;
		commit.header = commit.merge;
		commit.body = null;
	}

	const files = getChangedFilesForCommit( commit.hash );

	if ( !files.length ) {
		return;
	}

	const packageName = context.packageData.name;
	const packageDirectory = packageName.startsWith( '@' ) ? packageName.split( '/' )[ 1 ] : packageName;

	if ( !isValidCommit( files, packageDirectory ) ) {
		return;
	}

	return transformCommitForSubRepository( commit, context );
};

function isValidCommit( files, packageName ) {
	// Commit is valid for the package if at least one file in the package was changed.
	return files.some( filePath => {
		return filePath.startsWith( `packages/${ packageName }` );
	} );
}
