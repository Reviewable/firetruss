'use strict';

const nodeResolve = require('@rollup/plugin-node-resolve').nodeResolve;
const commonjs = require('@rollup/plugin-commonjs');

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
          to: () => `const VERSION = '${grunt.option('release')}';`
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
        sourcemap: true,
        globals: {
          vue: 'Vue',
          lodash: '_'
        }
      },
      firetruss: {
        options: {
          format: 'umd',
          name: 'Truss',
          plugins: [
            commonjs(),
            nodeResolve({
              resolveOnly: ['performance-now']
            })
          ]
        },
        files: {
          'dist/firetruss.umd.js': ['src/Truss.js']
        }
      },
      firetrussnext: {
        options: {
          format: 'es',
          plugins: [
            commonjs(),
            nodeResolve({
              resolveOnly: ['bogus']  // leaving the array empty ignores the option
            })
          ],
        },
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
        afterBump: ['replace --release=<%= version %>'],
        beforeRelease: ['default'],
        afterRelease: ['exec:reset']
      }
    },

    exec: {
      reset: 'git reset --hard'
    }

  });

  grunt.registerTask('default', [
    'eslint', 'clean:dist', 'rollup', 'uglify', 'gitadd'
  ]);

};
