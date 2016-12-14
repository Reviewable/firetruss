'use strict';

const buble = require('rollup-plugin-buble');
const nodeResolve = require('rollup-plugin-node-resolve');
const commonjs = require('rollup-plugin-commonjs');

module.exports = function(grunt) {

  require('load-grunt-tasks')(grunt);

  grunt.initConfig({
    pkg: grunt.file.readJSON('package.json'),

    clean: {
      dist: ['dist']
    },

    rollup: {
      options: {
        sourceMap: true,
        sourceMapRelativePaths: true,
        globals: {
          vue: 'Vue',
          lodash: '_'
        },
        plugins: [
          commonjs(),
          buble({
            transforms: {
              dangerousForOf: true
            }
          }),
          nodeResolve({
            jsnext: true,
            skip: ['vue', 'lodash']
          })
        ]
      },
      firetruss: {
        options: {
          format: 'umd',
          moduleName: 'Truss'
        },
        files: {
          'dist/firetruss.js': ['src/client/Truss.js']
        }
      },
      worker: {
        options: {
          format: 'iife'
        },
        files: {
          'dist/worker.js': ['src/worker/worker.js']
        }
      }
    },

    uglify: {
      options: {
        mangle: true,
        compress: true,
        sourceMap: true,
        sourceMapIn: src => src + '.map',
        sourceMapName: dest => dest + '.map',
      },
      firetruss: {
        src: 'dist/firetruss.js',
        dest: 'dist/firetruss.min.js'
      },
      worker: {
        src: 'dist/worker.js',
        dest: 'dist/worker.min.js'
      }
    },

    gitadd: {
      dist: {
        src: 'dist/*'
      }
    },

    release: {
      options: {
        additionalFiles: ['bower.json'],
        beforeBump: ['default']
      }
    }

  });

  grunt.registerTask('default', [
    'clean:dist', 'rollup', 'uglify', 'gitadd'
  ]);

};
