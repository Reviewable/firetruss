'use strict';
/* eslint-env node */

const buble = require('rollup-plugin-buble');
const nodeResolve = require('rollup-plugin-node-resolve');
const commonjs = require('rollup-plugin-commonjs');

module.exports = function(grunt) {

  require('load-grunt-tasks')(grunt);

  grunt.initConfig({
    pkg: grunt.file.readJSON('package.json'),
    ext: {version: 'dev'},

    clean: {
      dist: ['dist']
    },

    replace: {
      version: {
        src: 'src/Truss.js',
        overwrite: true,
        replacements: [{
          from: /const VERSION = '.*?';/,
          to: () => `const VERSION = '${grunt.config('ext.version')}';`
        }]
      }
    },

    eslint: {
      all: {
        options: {
          maxWarnings: 0
        },
        src: ['src/**/*.js'],
      }
    },

    rollup: {
      options: {
        sourceMap: true,
        sourceMapRelativePaths: true,
        globals: {
          vue: 'Vue',
          lodash: '_'
        }
      },
      firetruss: {
        options: {
          format: 'umd',
          moduleName: 'Truss',
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
        files: {
          'dist/firetruss.umd.js': ['src/Truss.js']
        }
      },
      firetrussnext: {
        options: {
          format: 'es'
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
            skip: ['vue', 'lodash', 'performance-now']
          })
        ],
        files: {
          'dist/firetruss.es2015.js': ['src/Truss.js']
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
        src: 'dist/firetruss.umd.js',
        dest: 'dist/firetruss.umd.min.js'
      }
    },

    gitadd: {
      dist: {
        src: 'dist/*'
      }
    },

    watch: {
      dev: {
        files: ['src/**/*.js'],
        tasks: ['default'],
        options: {spawn: false}
      }
    },

    release: {
      options: {
        additionalFiles: ['bower.json'],
        updateVars: ['ext'],
        afterBump: ['replace'],
        beforeRelease: ['default']
      }
    }

  });

  grunt.registerTask('default', [
    'eslint', 'clean:dist', 'rollup', 'uglify', 'gitadd'
  ]);

};
