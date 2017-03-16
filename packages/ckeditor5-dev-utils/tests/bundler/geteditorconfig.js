/**
 * @license Copyright (c) 2003-2017, CKSource - Frederico Knabben. All rights reserved.
 * For licensing, see LICENSE.md.
 */

/* jshint mocha:true */

'use strict';

const chai = require( 'chai' );
const expect = chai.expect;

describe( 'bundler', () => {
	let createEntryFile;

	beforeEach( () => {
		createEntryFile = require( '../../lib/bundler/createentryfile' );
	} );

	describe( 'createEntryFile()', () => {
		it( 'should be a function', () => {
			expect( createEntryFile ).to.be.a( 'function' );
		} );
	} );
} );